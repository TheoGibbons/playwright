import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { unzipSync } from 'fflate';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { config as baseConfig } from '../src/config.js';
import { BAND_COLORS, HEADER_COLOR, startFixtureServer } from './fixtures.js';

const KEY = 'test-key-0123456789abcdef';
let fixtures;

before(async () => {
  fixtures = await startFixtureServer();
});

after(async () => {
  await fixtures.close();
});

async function startApp(overrides = {}) {
  const app = await createApp({
    ...baseConfig,
    apiKeys: [KEY],
    logLevel: 'silent',
    allowPrivateNetworks: true, // the fixture site lives on 127.0.0.1
    ...overrides,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (body, { key = KEY } = {}) =>
    fetch(`${base}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key && { authorization: `Bearer ${key}` }) },
      body: JSON.stringify(body),
    });
  return { app, base, post };
}

async function pixel(img, x, y) {
  const { data } = await sharp(img).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  return `#${[...data.subarray(0, 3)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

describe('render API', () => {
  let svc;
  before(async () => {
    svc = await startApp();
  });
  after(async () => {
    await svc.app.close();
  });

  describe('auth and validation', () => {
    test('rejects missing and wrong keys', async () => {
      assert.equal((await svc.post({ url: fixtures.url('/late') }, { key: null })).status, 401);
      assert.equal((await svc.post({ url: fixtures.url('/late') }, { key: 'nope-nope-nope-nope' })).status, 401);
    });

    test('accepts X-API-Key as well as Bearer', async () => {
      const res = await fetch(`${svc.base}/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': KEY },
        body: JSON.stringify({ url: fixtures.url('/hidden'), format: 'html', wait: { until: 'load' } }),
      });
      assert.equal(res.status, 200);
    });

    test('rejects unknown fields instead of ignoring them', async () => {
      const res = await svc.post({ url: fixtures.url('/late'), fullpage: true });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'invalid_request');
    });

    test('rejects non-http URLs', async () => {
      const res = await svc.post({ url: 'file:///etc/passwd' });
      assert.equal(res.status, 400);
    });

    test('health check needs no key', async () => {
      const res = await fetch(`${svc.base}/healthz`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).browser.running, true);
    });
  });

  describe('waiting', () => {
    test('domcontentloaded captures before late JS has run', async () => {
      const res = await svc.post({ url: fixtures.url('/late'), format: 'html', wait: { until: 'domcontentloaded' } });
      assert.doesNotMatch(await res.text(), /<div id="late">/);
    });

    test('selector waits for late content', async () => {
      const res = await svc.post({ url: fixtures.url('/late'), format: 'html', wait: { selector: '#late' } });
      assert.equal(res.headers.get('x-wait-timed-out'), 'false');
      assert.match(await res.text(), /<div id="late">late content<\/div>/);
    });

    test('expression waits, and tolerates errors while the app boots', async () => {
      const res = await svc.post({ url: fixtures.url('/late'), format: 'html', wait: { expression: 'window.app.ready === true' } });
      assert.match(await res.text(), /<div id="late">late content<\/div>/);
    });

    test('settled (the default) waits for DOM changes to stop', async () => {
      const res = await svc.post({ url: fixtures.url('/trickle'), format: 'html' });
      assert.match(await res.text(), /<li>item 7<\/li>/);
    });

    test('a timed-out wait still returns the page, flagged in a header', async () => {
      const res = await svc.post({ url: fixtures.url('/late'), format: 'html', wait: { selector: '#never', timeoutMs: 500 } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-wait-timed-out'), 'true');
    });

    test('strict waits fail with 504 instead', async () => {
      const res = await svc.post({ url: fixtures.url('/late'), format: 'html', wait: { selector: '#never', timeoutMs: 500, strict: true } });
      assert.equal(res.status, 504);
      assert.equal((await res.json()).error, 'wait_timeout');
    });

    test('scrollToLoad triggers lazy content', async () => {
      const lazy = await svc.post({ url: fixtures.url('/lazy') });
      assert.ok(Number(lazy.headers.get('x-page-height')) >= 3000, `height ${lazy.headers.get('x-page-height')}`);

      const eager = await svc.post({ url: fixtures.url('/lazy'), scrollToLoad: false });
      assert.ok(Number(eager.headers.get('x-page-height')) < 1100);
    });
  });

  describe('screenshots', () => {
    test('stitches a tall page from tiles without repeating the fixed header', async () => {
      const res = await svc.post({ url: fixtures.url('/tall?h=9000') });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/png');
      assert.equal(res.headers.get('x-truncated'), 'false');
      const img = Buffer.from(await res.arrayBuffer());
      const meta = await sharp(img).metadata();
      assert.deepEqual([meta.width, meta.height], [1280, 9000]);

      assert.equal(await pixel(img, 10, 10), HEADER_COLOR);
      for (let band = 0; band < 9; band++) {
        // Sample just below each tile seam (4096, 8192) as well as mid-band.
        assert.equal(await pixel(img, 10, band * 1000 + 500), BAND_COLORS[band % BAND_COLORS.length], `band ${band}`);
      }
      assert.equal(await pixel(img, 10, 4096 + 10), BAND_COLORS[4]);
      assert.equal(await pixel(img, 10, 8192 + 10), BAND_COLORS[8 % BAND_COLORS.length]);
    });

    test('a 100vh hero keeps its viewport height in a full-page shot', async () => {
      const res = await svc.post({ url: fixtures.url('/hero') });
      const img = Buffer.from(await res.arrayBuffer());
      assert.equal((await sharp(img).metadata()).height, 3800);
      assert.equal(await pixel(img, 10, 790), '#ff0000');
      assert.equal(await pixel(img, 10, 810), '#0000ff');
    });

    test('viewport-only screenshot', async () => {
      const res = await svc.post({ url: fixtures.url('/tall?h=3000'), fullPage: false, viewport: { width: 800, height: 600 } });
      const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
      assert.deepEqual([meta.width, meta.height], [800, 600]);
    });

    test('jpeg and webp at 2x scale', async () => {
      for (const format of ['jpeg', 'webp']) {
        const res = await svc.post({ url: fixtures.url('/tall?h=1500'), format, viewport: { width: 640, scale: 2 } });
        assert.equal(res.headers.get('content-type'), `image/${format}`);
        const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
        assert.deepEqual([meta.format, meta.width, meta.height], [format, 1280, 3000]);
      }
    });

    describe('when the page is taller than maxHeight', () => {
      const tall = () => ({ url: fixtures.url('/tall?h=6000'), maxHeight: 3000 });

      test('truncate (default) cuts at maxHeight and says so', async () => {
        const res = await svc.post(tall());
        assert.equal(res.headers.get('x-truncated'), 'true');
        assert.equal(res.headers.get('x-page-height'), '6000');
        const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
        assert.deepEqual([meta.width, meta.height], [1280, 3000]);
      });

      test('scale shrinks the whole page to fit', async () => {
        const res = await svc.post({ ...tall(), overflow: 'scale' });
        assert.equal(res.headers.get('x-scale-factor'), '0.5');
        const img = Buffer.from(await res.arrayBuffer());
        const meta = await sharp(img).metadata();
        assert.deepEqual([meta.width, meta.height], [640, 3000]);
        assert.equal(await pixel(img, 5, 2750), BAND_COLORS[5]); // band 5 (5000-6000px) is at 2500-3000
      });

      test('tiles returns a zip of images plus a manifest', async () => {
        const res = await svc.post({ ...tall(), overflow: 'tiles', tileHeight: 2048 });
        assert.equal(res.headers.get('content-type'), 'application/zip');
        assert.equal(res.headers.get('x-tile-count'), '3');
        const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
        assert.deepEqual(Object.keys(files).sort(), ['manifest.json', 'tile-001.png', 'tile-002.png', 'tile-003.png']);
        const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString());
        assert.deepEqual(manifest.tiles.map((t) => [t.y, t.height]), [[0, 2048], [2048, 2048], [4096, 1904]]);
      });

      test('error returns 422 with the measurements', async () => {
        const res = await svc.post({ ...tall(), overflow: 'error' });
        assert.equal(res.status, 422);
        const body = await res.json();
        assert.equal(body.error, 'page_too_tall');
        assert.equal(body.pageHeight, 6000);
        assert.equal(body.maxHeight, 3000);
      });
    });
  });

  describe('other formats', () => {
    test('pdf', async () => {
      const res = await svc.post({ url: fixtures.url('/late'), format: 'pdf' });
      assert.equal(res.headers.get('content-type'), 'application/pdf');
      assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    });

    test('html includes a <base> so relative URLs keep working', async () => {
      const res = await svc.post({ url: fixtures.url('/late'), format: 'html' });
      assert.match(await res.text(), new RegExp(`<base href="${fixtures.url('/late').replace(/[?.]/g, '\\$&')}">`));
    });

    test('mhtml', async () => {
      const res = await svc.post({ url: fixtures.url('/late'), format: 'mhtml' });
      assert.match(await res.text(), /Content-Type: multipart\/related/);
    });

    test('hideSelectors removes elements from html output', async () => {
      const res = await svc.post({ url: fixtures.url('/hidden'), format: 'html', hideSelectors: ['.banner'] });
      const html = await res.text();
      assert.doesNotMatch(html, /COOKIE BANNER/);
      assert.match(html, /body text/);
    });
  });

  describe('headers and cookies', () => {
    test('extra headers go to the target origin only', async () => {
      const before = fixtures.requests.length;
      const res = await svc.post({ url: fixtures.url('/headers'), format: 'html', headers: { 'X-Secret': 's3cret' } });
      assert.match(await res.text(), /s3cret/);
      const pixelReq = fixtures.requests.slice(before).find((r) => r.path === '/pixel');
      assert.ok(pixelReq, 'cross-origin pixel was requested');
      assert.equal(pixelReq.headers['x-secret'], undefined);
    });

    test('cookies are set for the target URL', async () => {
      const res = await svc.post({ url: fixtures.url('/cookies'), format: 'html', cookies: [{ name: 'session', value: 'abc123' }] });
      assert.match(await res.text(), /session=abc123/);
    });
  });

  describe('browser identity', () => {
    const identity = async (body = {}) => {
      const res = await svc.post({ url: fixtures.url('/identity'), format: 'html', wait: { until: 'load' }, ...body });
      return JSON.parse(/<pre id="identity">(.*?)<\/pre>/.exec(await res.text())[1]);
    };

    test('does not announce itself as headless or automated', async () => {
      const seen = await identity();
      assert.doesNotMatch(seen.header, /Headless/);
      assert.match(seen.header, / Chrome\/\d+\.0\.0\.0 /);
      assert.equal(seen.userAgent, seen.header);
      assert.equal(seen.webdriver, false);
    });

    test('a userAgent in the request replaces the default', async () => {
      const seen = await identity({ userAgent: 'custom-agent/1.0' });
      assert.equal(seen.header, 'custom-agent/1.0');
      assert.equal(seen.userAgent, 'custom-agent/1.0');
    });
  });
});

describe('egress policy through the API', () => {
  let svc;
  before(async () => {
    svc = await startApp({ allowPrivateNetworks: false });
  });
  after(async () => {
    await svc.app.close();
  });

  test('internal targets are refused with 403', async () => {
    for (const url of [fixtures.url('/late'), `http://localhost:${fixtures.port}/late`, 'http://169.254.169.254/latest/meta-data/']) {
      const res = await svc.post({ url });
      assert.equal(res.status, 403, url);
      assert.equal((await res.json()).error, 'blocked_address');
    }
  });
});

describe('limits', () => {
  let svc;
  before(async () => {
    svc = await startApp({ maxConcurrency: 1, maxQueue: 0, jobTimeoutMs: 1500 });
  });
  after(async () => {
    await svc.app.close();
  });

  test('jobs over the time limit get 504', async () => {
    const res = await svc.post({ url: fixtures.url('/late'), format: 'html', wait: { until: 'load', delayMs: 5000 } });
    assert.equal(res.status, 504);
    assert.equal((await res.json()).error, 'job_timeout');
  });

  test('a full queue answers 503 with Retry-After', async () => {
    const slow = svc.post({ url: fixtures.url('/late'), format: 'html', wait: { until: 'load', delayMs: 800 } });
    await new Promise((r) => setTimeout(r, 200));
    const rejected = await svc.post({ url: fixtures.url('/late'), format: 'html' });
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers.get('retry-after'), '5');
    assert.equal((await slow).status, 200);
  });

  test('the service still works after a timeout killed a context', async () => {
    const res = await svc.post({ url: fixtures.url('/hidden'), format: 'html', wait: { until: 'load' } });
    assert.equal(res.status, 200);
  });
});

describe('idle shutdown', () => {
  let svc;
  const browserStatus = async () => (await (await fetch(`${svc.base}/healthz`)).json()).browser;
  const quickRender = () => svc.post({ url: fixtures.url('/hidden'), format: 'html', wait: { until: 'load' } });

  before(async () => {
    svc = await startApp({ idleShutdownMs: 300 });
  });
  after(async () => {
    await svc.app.close();
  });

  test('closes Chromium when idle and relaunches it on the next request', async () => {
    await sleep(600);
    assert.equal((await browserStatus()).running, false);

    assert.equal((await quickRender()).status, 200);
    assert.equal((await browserStatus()).running, true);

    await sleep(600);
    assert.equal((await browserStatus()).running, false);
  });

  test('concurrent requests after an idle stop share one relaunch', async () => {
    await sleep(600);
    const statuses = await Promise.all([quickRender(), quickRender(), quickRender()]).then((rs) => rs.map((r) => r.status));
    assert.deepEqual(statuses, [200, 200, 200]);
    assert.equal((await browserStatus()).served, 3, 'all three renders ran on the same freshly launched browser');
  });

  test('a render longer than the idle timeout is not interrupted', async () => {
    const res = await svc.post({ url: fixtures.url('/late'), format: 'html', wait: { until: 'load', delayMs: 1000 } });
    assert.equal(res.status, 200);
  });
});
