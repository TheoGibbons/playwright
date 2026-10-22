import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { BrowserManager } from './browser.js';
import { startEgressProxy } from './egress-proxy.js';
import { HttpError, clientGone, jobTimeout } from './errors.js';
import { BlockedAddressError, resolveAllowed } from './net-guard.js';
import { JobQueue, QueueFullError } from './queue.js';
import { render } from './render.js';
import { normalizeOptions, renderBodySchema } from './schema.js';

/** Builds the HTTP app plus the browser and egress proxy behind it. */
export async function createApp(config) {
  const app = Fastify({
    logger: { level: config.logLevel },
    // Reject unknown fields (typos like "fullpage") instead of silently dropping them.
    ajv: { customOptions: { removeAdditional: false, useDefaults: true, coerceTypes: false } },
  });

  const proxy = await startEgressProxy({ allowPrivate: config.allowPrivateNetworks, log: app.log.child({ component: 'egress' }) });
  const browsers = new BrowserManager({
    proxyUrl: proxy.url,
    sandbox: config.chromiumSandbox,
    recycleAfter: config.recycleAfter,
    log: app.log.child({ component: 'browser' }),
  });
  await browsers.start();

  const queue = new JobQueue({ concurrency: config.maxConcurrency, maxQueue: config.maxQueue });
  const authenticate = apiKeyHook(config.apiKeys);

  app.addHook('onClose', async () => {
    await browsers.close();
    await proxy.close();
  });

  app.setErrorHandler((err, request, reply) => {
    const http = toHttpError(err);
    if (http.statusCode >= 500 && http.code !== 'job_timeout') request.log.error({ err }, 'render failed');
    if (err instanceof QueueFullError) reply.header('retry-after', '5');
    reply.code(http.statusCode).send(http.toJSON());
  });

  app.get('/healthz', async () => ({ ok: true, browser: browsers.status, queue: queue.stats }));

  app.post('/render', { schema: { body: renderBodySchema }, onRequest: authenticate }, async (request, reply) => {
    const opts = normalizeOptions(request.body, config);

    // Early, readable error for obviously internal targets. The egress proxy
    // still checks every connection (redirects, subresources) on its own.
    await resolveAllowed(new URL(opts.url).hostname, { allowPrivate: config.allowPrivateNetworks });

    const controller = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) controller.abort(clientGone());
    });

    const result = await queue.run(async () => {
      const timer = setTimeout(() => controller.abort(jobTimeout(config.jobTimeoutMs)), config.jobTimeoutMs);
      try {
        return await render(opts, { browsers, limits: config, signal: controller.signal, log: request.log });
      } finally {
        clearTimeout(timer);
      }
    }, controller.signal);

    const { meta } = result;
    request.log.info({ url: opts.url, format: opts.format, ms: meta.renderMs, bytes: result.body.length }, 'rendered');

    reply
      .type(result.contentType)
      .header('cache-control', 'no-store')
      .header('content-disposition', `inline; filename="page.${result.extension}"`)
      .header('x-final-url', encodeURI(meta.finalUrl))
      .header('x-render-ms', meta.renderMs)
      .header('x-wait-timed-out', meta.waitTimedOut);
    if (meta.upstreamStatus !== undefined) reply.header('x-upstream-status', meta.upstreamStatus);
    if (meta.pageHeight !== undefined) reply.header('x-page-height', meta.pageHeight);
    if (meta.truncated !== undefined) reply.header('x-truncated', meta.truncated);
    if (meta.scaleFactor !== undefined) reply.header('x-scale-factor', meta.scaleFactor);
    if (meta.tileCount !== undefined) reply.header('x-tile-count', meta.tileCount);
    if (meta.adblock !== undefined) reply.header('x-adblock', meta.adblock ? 'on' : 'unavailable');
    return reply.send(result.body);
  });

  return app;
}

function apiKeyHook(apiKeys) {
  // Hash first so timingSafeEqual always compares equal-length buffers.
  const digest = (s) => createHash('sha256').update(s).digest();
  const known = apiKeys.map(digest);

  return async (request) => {
    const header = request.headers.authorization;
    const provided = header?.startsWith('Bearer ') ? header.slice(7).trim() : request.headers['x-api-key'];
    if (typeof provided !== 'string' || provided === '') {
      throw new HttpError(401, 'unauthorized', 'Send an API key as "Authorization: Bearer <key>" or "X-API-Key: <key>"');
    }
    const candidate = digest(provided);
    let ok = false;
    for (const key of known) ok = timingSafeEqual(key, candidate) || ok;
    if (!ok) throw new HttpError(401, 'unauthorized', 'Invalid API key');
  };
}

function toHttpError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof QueueFullError) return new HttpError(503, 'queue_full', 'Too many renders in progress; retry shortly');
  if (err instanceof BlockedAddressError) return new HttpError(403, 'blocked_address', err.message);
  if (err.code === 'DNS_FAILED') return new HttpError(502, 'dns_failed', err.message);
  if (err.validation) return new HttpError(400, 'invalid_request', err.message);
  if (err.statusCode >= 400 && err.statusCode < 500) return new HttpError(err.statusCode, 'invalid_request', err.message);
  return new HttpError(500, 'internal_error', 'Render failed unexpectedly');
}
