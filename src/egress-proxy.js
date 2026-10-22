// A tiny forward proxy that every Chromium connection goes through.
//
// Checking URLs in page.route() is not enough to stop SSRF: route handlers don't
// see redirects, WebSockets or service-worker traffic, and Chromium resolves DNS
// again after the check. Here we resolve the name ourselves, vet the address and
// connect to exactly that address, for every request the browser makes.

import http from 'node:http';
import net from 'node:net';
import { BlockedAddressError, pinnedLookup, resolveAllowed, stripBrackets } from './net-guard.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'upgrade',
]);

function stripHopByHop(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

export async function startEgressProxy({ allowPrivate, log }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

  const server = http.createServer(async (req, res) => {
    // Plain-HTTP requests arrive in absolute form: GET http://host/path
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end('Expected an absolute URL');
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400).end('Only http:// is proxied directly; use CONNECT for TLS');
      return;
    }

    let addresses;
    try {
      addresses = await resolveAllowed(target.hostname, { allowPrivate });
    } catch (err) {
      reject(res, err, target.host);
      return;
    }

    const upstream = http.request({
      host: stripBrackets(target.hostname),
      lookup: pinnedLookup(addresses),
      port: target.port || 80,
      method: req.method,
      path: target.pathname + target.search,
      headers: stripHopByHop(req.headers),
      agent,
    });
    upstream.on('response', (upRes) => {
      res.writeHead(upRes.statusCode, upRes.statusMessage, stripHopByHop(upRes.headers));
      upRes.pipe(res);
    });
    upstream.on('error', (err) => {
      log.debug({ err, host: target.host }, 'egress upstream error');
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  // HTTPS and WebSockets are tunnelled: CONNECT host:port
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    let host;
    let port;
    try {
      const u = new URL(`http://${req.url}`);
      host = u.hostname;
      port = Number(u.port || 443);
    } catch {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    let addresses;
    try {
      addresses = await resolveAllowed(host, { allowPrivate });
    } catch (err) {
      if (err instanceof BlockedAddressError) log.info({ host: req.url }, 'egress blocked');
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    const upstream = net.connect({ host: stripBrackets(host), lookup: pinnedLookup(addresses), port });
    let established = false;
    upstream.once('connect', () => {
      established = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => {
      if (established) client.destroy();
      else client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    client.on('close', () => upstream.destroy());
  });

  function reject(res, err, host) {
    if (err instanceof BlockedAddressError) {
      log.info({ host }, 'egress blocked');
      // The header lets render.js turn a blocked redirect into a 403 for the caller.
      res.writeHead(403, { 'content-type': 'text/plain', 'x-egress-blocked': '1' }).end('Blocked by egress policy');
    } else {
      res.writeHead(502, { 'content-type': 'text/plain' }).end(err.message);
    }
  }

  await new Promise((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        agent.destroy();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
