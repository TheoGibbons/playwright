import { setTimeout as sleep } from 'node:timers/promises';
import { errors as pwErrors } from 'playwright';
import { enableAdblock } from './adblock.js';
import { HttpError } from './errors.js';
import { captureScreenshot } from './screenshot.js';
import { scrollToLoad, trackNetwork, waitForReady } from './wait.js';

/**
 * Loads `opts.url` in a fresh browser context and produces the requested
 * output: { body, contentType, extension, meta }.
 *
 * Aborting `signal` closes the context, which makes any pending Playwright call
 * reject; the abort reason is rethrown in place of that error.
 */
export async function render(opts, { browsers, limits, signal, log }) {
  const started = Date.now();
  const context = await browsers.newContext({
    viewport: { width: opts.viewport.width, height: opts.viewport.height },
    deviceScaleFactor: opts.viewport.scale,
    colorScheme: opts.colorScheme,
    ...(opts.userAgent && { userAgent: opts.userAgent }),
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  const kill = () => context.close().catch(() => {});
  signal.addEventListener('abort', kill, { once: true });

  try {
    signal.throwIfAborted();
    const result = await renderInContext(context, opts, { limits, signal, log });
    signal.throwIfAborted();
    result.meta.renderMs = Date.now() - started;
    return result;
  } catch (err) {
    if (signal.aborted) throw signal.reason;
    throw err;
  } finally {
    signal.removeEventListener('abort', kill);
    await context.close().catch(() => {});
  }
}

async function renderInContext(context, opts, { limits, signal, log }) {
  if (opts.cookies?.length) await context.addCookies(opts.cookies.map((c) => toPlaywrightCookie(c, opts.url)));

  const page = await context.newPage();
  context.on('page', (popup) => {
    if (popup !== page) popup.close().catch(() => {});
  });
  page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));

  // Route handlers run newest-first, so the header route goes on after the
  // ad blocker's and hands each request on to it with route.fallback().
  const adblock = opts.blockAds ? await enableAdblock(page, log) : undefined;
  if (opts.headers && Object.keys(opts.headers).length > 0) await addOriginHeaders(page, opts.url, opts.headers);

  const network = trackNetwork(page);
  let response;
  try {
    response = await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: limits.navigationTimeoutMs });
  } catch (err) {
    if (signal.aborted) throw err;
    if (err instanceof pwErrors.TimeoutError) {
      throw new HttpError(504, 'navigation_timeout', `${opts.url} did not respond within ${limits.navigationTimeoutMs}ms`);
    }
    const hint = /ERR_TUNNEL_CONNECTION_FAILED/.test(err.message)
      ? ' (the egress proxy refused it: a non-public address, possibly after a redirect, or the host is unreachable)'
      : '';
    throw new HttpError(502, 'navigation_failed', `Could not load ${opts.url}: ${firstLine(err)}${hint}`);
  }
  if (response?.headers()['x-egress-blocked']) {
    throw new HttpError(403, 'blocked_address', `${opts.url} redirected to a non-public address (${page.url()})`);
  }

  const { timedOut } = await waitForReady(page, network, opts.wait, signal);
  if (opts.scrollToLoad) await scrollToLoad(page, network, { maxHeight: limits.maxCaptureHeight, signal });
  if (opts.wait.delayMs > 0) await sleep(opts.wait.delayMs, undefined, { signal });

  const isDocument = opts.format === 'html' || opts.format === 'mhtml';
  if (opts.hideSelectors.length > 0) await hideElements(page, opts.hideSelectors, { remove: isDocument });

  const output = await produce(page, opts, limits);
  output.meta = {
    finalUrl: page.url(),
    upstreamStatus: response?.status(),
    waitTimedOut: timedOut,
    adblock,
    ...output.meta,
  };
  return output;
}

async function produce(page, opts, limits) {
  switch (opts.format) {
    case 'pdf': {
      const { paper, landscape, margin, media, scale, printBackground } = opts.pdf;
      await page.emulateMedia({ media });
      const body = await page.pdf({
        format: paper,
        landscape,
        scale,
        printBackground,
        margin: { top: margin, right: margin, bottom: margin, left: margin },
      });
      return { body, contentType: 'application/pdf', extension: 'pdf', meta: {} };
    }

    case 'html': {
      if (opts.html.baseHref) {
        // Keeps relative links, images and CSS working when the file is opened elsewhere.
        await page.evaluate((href) => {
          if (document.querySelector('base[href]')) return;
          const base = document.createElement('base');
          base.href = href;
          (document.head ?? document.documentElement).prepend(base);
        }, page.url());
      }
      return { body: await page.content(), contentType: 'text/html; charset=utf-8', extension: 'html', meta: {} };
    }

    case 'mhtml': {
      const cdp = await page.context().newCDPSession(page);
      const { data } = await cdp.send('Page.captureSnapshot', { format: 'mhtml' });
      return { body: data, contentType: 'application/x-mimearchive', extension: 'mhtml', meta: {} };
    }

    default:
      return captureScreenshot(page, opts, limits);
  }
}

/** Extra headers go only to the requested URL's origin, never to third parties. */
async function addOriginHeaders(page, targetUrl, headers) {
  const origin = new URL(targetUrl).origin;
  const extra = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  await page.route('**/*', (route) => {
    const request = route.request();
    if (originOf(request.url()) !== origin) return route.fallback();
    return route.fallback({ headers: { ...request.headers(), ...extra } });
  });
}

function hideElements(page, selectors, { remove }) {
  return page.evaluate(
    ({ selectors, remove }) => {
      for (const selector of selectors) {
        let nodes;
        try {
          nodes = document.querySelectorAll(selector);
        } catch {
          continue; // invalid selector
        }
        for (const el of nodes) {
          if (remove) el.remove();
          else el.style.setProperty('display', 'none', 'important');
        }
      }
    },
    { selectors, remove },
  );
}

function toPlaywrightCookie(c, url) {
  const { name, value, domain, path, secure, httpOnly, sameSite } = c;
  const flags = { secure, httpOnly, sameSite };
  // Playwright wants either a url, or a domain plus path.
  return domain ? { name, value, domain, path: path ?? '/', ...flags } : { name, value, url, ...flags };
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0];
}
