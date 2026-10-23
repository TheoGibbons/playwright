// A local site with pages that exercise each rendering behaviour.

import http from 'node:http';

export const BAND_COLORS = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff'];
export const HEADER_COLOR = '#123456';

const pages = {
  '/late': () => `<!doctype html><title>late</title><div id="root">loading</div>
    <script>
      setTimeout(() => {
        const d = document.createElement('div');
        d.id = 'late';
        d.textContent = 'late content';
        document.body.append(d);
        window.app = { ready: true };
      }, 1200);
    </script>`,

  // Keeps adding items every 300ms for ~2s, the way a feed hydrates.
  '/trickle': () => `<!doctype html><ul id="list"></ul>
    <script>
      let n = 0;
      const timer = setInterval(() => {
        const li = document.createElement('li');
        li.textContent = 'item ' + ++n;
        document.getElementById('list').append(li);
        if (n === 7) clearInterval(timer);
      }, 300);
    </script>`,

  // Exactly `h` CSS px tall, 1000px colour bands, plus a fixed header.
  '/tall': (q) => {
    const h = Number(q.get('h') ?? 6000);
    const bands = [];
    for (let y = 0, i = 0; y < h; y += 1000, i++) {
      bands.push(`<div style="height:${Math.min(1000, h - y)}px;background:${BAND_COLORS[i % BAND_COLORS.length]}"></div>`);
    }
    return `<!doctype html><style>body{margin:0}</style>
      <header style="position:fixed;top:0;left:0;right:0;height:50px;background:${HEADER_COLOR}"></header>
      ${bands.join('')}`;
  },

  // A 100vh hero followed by 3000px of content.
  '/hero': () => `<!doctype html><style>body{margin:0}</style>
    <div style="height:100vh;background:#ff0000"></div>
    <div style="height:3000px;background:#0000ff"></div>`,

  // Grows by 2000px once the bottom sentinel scrolls into view.
  '/lazy': () => `<!doctype html><style>body{margin:0}</style>
    <div style="height:1000px;background:#eeeeee"></div>
    <div id="sentinel" style="height:10px"></div>
    <script>
      new IntersectionObserver((entries, observer) => {
        if (!entries[0].isIntersecting) return;
        observer.disconnect();
        const more = document.createElement('div');
        more.id = 'more';
        more.style.height = '2000px';
        document.body.append(more);
      }).observe(document.getElementById('sentinel'));
    </script>`,

  // Shows the request headers; also loads a resource from a second origin.
  '/headers': (q, req, port) => `<!doctype html>
    <pre id="headers">${escape(JSON.stringify(req.headers))}</pre>
    <img src="http://localhost:${port}/pixel">`,

  // What a bot check sees: the User-Agent header and what scripts can read.
  '/identity': (q, req) => `<!doctype html><pre id="identity"></pre>
    <script>
      document.getElementById('identity').textContent = JSON.stringify({
        header: ${JSON.stringify(req.headers['user-agent'] ?? '')},
        userAgent: navigator.userAgent,
        webdriver: navigator.webdriver,
      });
    </script>`,

  '/cookies': (q, req) => `<!doctype html><pre id="cookie">${escape(req.headers.cookie ?? '')}</pre>`,

  '/hidden': () => `<!doctype html><div class="banner">COOKIE BANNER</div><p>body text</p>`,
};

function escape(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

/** Starts the fixture site. `requests` records every request path and headers. */
export async function startFixtureServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push({ path: url.pathname, headers: req.headers });
    const page = pages[url.pathname];
    if (page) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(url.searchParams, req, server.address().port));
    } else if (url.pathname === '/pixel') {
      res.writeHead(204).end();
    } else {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
