// Proves Chromium cannot reach internal addresses through any path.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { BrowserManager } from '../src/browser.js';
import { startEgressProxy } from '../src/egress-proxy.js';
import { startFixtureServer } from './fixtures.js';

const log = { info() {}, warn() {}, debug() {}, error() {}, child: () => log };
let fixtures;
let proxy;
let browsers;

before(async () => {
  fixtures = await startFixtureServer();
  proxy = await startEgressProxy({ allowPrivate: false, log });
  browsers = new BrowserManager({ proxyUrl: proxy.url, sandbox: false, recycleAfter: 100, log });
  await browsers.start();
});

after(async () => {
  await browsers.close();
  await proxy.close();
  await fixtures.close();
});

test('proxy refuses plain HTTP to loopback', async () => {
  const { port } = new URL(proxy.url);
  const res = await new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: fixtures.url('/late') }, (res) => {
        res.resume();
        resolve(res);
      })
      .on('error', reject);
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.headers['x-egress-blocked'], '1');
});

test('proxy refuses CONNECT tunnels to loopback', async () => {
  const { port } = new URL(proxy.url);
  const status = await new Promise((resolve, reject) => {
    http
      .request({ host: '127.0.0.1', port, method: 'CONNECT', path: `localhost:${fixtures.port}` })
      .on('connect', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode);
      })
      .on('response', (res) => resolve(res.statusCode))
      .on('error', reject)
      .end();
  });
  assert.equal(status, 403);
});

// Serves `html` as if it came from a public site, so the browser treats
// requests to loopback as coming from a normal web page.
async function loadAsPublicPage(manager, html) {
  const context = await manager.newContext();
  const page = await context.newPage();
  await page.route('http://public.example/', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://public.example/');
  await sleep(1500);
  await context.close();
}

function probeHtml() {
  const base = `127.0.0.1:${fixtures.port}`;
  return `
    <img src="http://${base}/ssrf-img">
    <iframe src="http://localhost:${fixtures.port}/ssrf-iframe"></iframe>
    <script>
      fetch('http://${base}/ssrf-fetch').catch(() => {});
      try { new WebSocket('ws://${base}/ssrf-ws'); } catch {}
    </script>`;
}

test('page content cannot reach loopback via img, iframe, fetch or WebSocket', async () => {
  const before = fixtures.requests.length;
  await loadAsPublicPage(browsers, probeHtml());
  assert.deepEqual(fixtures.requests.slice(before).map((r) => r.path), []);
});

test('control: the same page does reach loopback when private networks are allowed', async () => {
  const openProxy = await startEgressProxy({ allowPrivate: true, log });
  const openBrowsers = new BrowserManager({ proxyUrl: openProxy.url, sandbox: false, recycleAfter: 100, log });
  try {
    const before = fixtures.requests.length;
    await loadAsPublicPage(openBrowsers, probeHtml());
    const paths = fixtures.requests.slice(before).map((r) => r.path);
    for (const p of ['/ssrf-img', '/ssrf-iframe', '/ssrf-fetch', '/ssrf-ws']) assert.ok(paths.includes(p), `${p} missing; saw ${paths}`);
  } finally {
    await openBrowsers.close();
    await openProxy.close();
  }
});
