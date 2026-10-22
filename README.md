# render-service

A small HTTP API that loads a URL in headless Chromium (Playwright), waits for the page's JavaScript to finish, and returns one of:

- a **full-page screenshot** (PNG / JPEG / WebP), with a choice of what happens when the page is too tall
- a **PDF**
- the **rendered HTML**, or a self-contained **MHTML** archive

It is protected by API keys and runs as a single Docker container.

## Quick start

```bash
cp .env.example .env
# put a key in API_KEYS, e.g. the output of: openssl rand -hex 32
docker compose up -d --build

curl -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}' \
  -o page.png http://localhost:3000/render
```

To serve it over HTTPS, point a domain at the server, set `DOMAIN` in `.env` and run `docker compose --profile tls up -d`. Caddy gets the certificate automatically. When you do, bind the API port to localhost (`"127.0.0.1:3000:3000"`) so it is only reachable through Caddy.

## API

### `POST /render`

Authenticate with `Authorization: Bearer <key>` or `X-API-Key: <key>`. Only `url` is required. Unknown fields are rejected with 400, so typos don't go unnoticed.

```jsonc
{
  "url": "https://example.com",
  "format": "png",               // png | jpeg | webp | pdf | html | mhtml
  "quality": 80,                 // jpeg / webp
  "fullPage": true,
  "viewport": { "width": 1280, "height": 800, "scale": 1 },

  "wait": {
    "until": "settled",          // see "Waiting" below
    "selector": "#results",      // implies until: "selector"
    "expression": "window.app.ready === true", // implies until: "expression"
    "timeoutMs": 15000,
    "quietMs": 1000,             // for "settled"
    "delayMs": 0,                // extra fixed pause before capture
    "strict": false              // true: fail with 504 instead of capturing anyway
  },
  "scrollToLoad": true,          // default: true for full-page images and PDF

  "maxHeight": 32768,            // tallest image to return, in pixels
  "overflow": "truncate",        // truncate | scale | tiles | error
  "tileHeight": 4096,            // for overflow: "tiles"

  "hideSelectors": [".cookie-banner"],
  "blockAds": false,             // ads, trackers and cookie banners (Ghostery lists)
  "headers": { "Authorization": "..." }, // sent to the target's origin only
  "cookies": [{ "name": "session", "value": "abc" }],
  "colorScheme": "light",        // light | dark | no-preference
  "userAgent": "...",

  "pdf": { "paper": "A4", "landscape": false, "margin": "10mm", "media": "screen", "scale": 1, "printBackground": true },
  "html": { "baseHref": true }   // inject <base> so relative links work offline
}
```

The response body is the file itself. Response headers describe what happened:

| Header | Meaning |
|---|---|
| `X-Final-Url` | URL after redirects |
| `X-Upstream-Status` | HTTP status the site returned (the render still succeeds on 404/500 pages) |
| `X-Wait-Timed-Out` | `true` if the wait condition wasn't met and the page was captured as-is |
| `X-Page-Height` | Page height in CSS pixels (full-page screenshots) |
| `X-Truncated` | `true` if the image doesn't cover the whole page |
| `X-Scale-Factor` | Set when `overflow: "scale"` shrank the image |
| `X-Tile-Count` | Set when `overflow: "tiles"` returned a zip |
| `X-Adblock` | `on`, or `unavailable` if the filter lists couldn't be downloaded |
| `X-Render-Ms` | Time spent rendering |

### `GET /healthz`

Unauthenticated. Reports browser and queue state.

### Errors

Errors are JSON: `{"error": "<code>", "message": "..."}`.

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_request` | Bad body, bad URL, invalid selector or expression |
| 401 | `unauthorized` | Missing or wrong API key |
| 403 | `blocked_address` | The URL, or a redirect, points at a private or internal address |
| 422 | `page_too_tall` | `overflow: "error"` and the page exceeds `maxHeight` (includes `pageHeight`, `maxHeight`) |
| 502 | `navigation_failed`, `dns_failed` | The site couldn't be loaded |
| 503 | `queue_full` | Too many requests waiting; has `Retry-After` |
| 504 | `navigation_timeout`, `wait_timeout`, `job_timeout` | Something took too long |

## Waiting

Single-page apps rarely have a clear "done" moment, so you pick the strategy:

| `until` | Waits for |
|---|---|
| `settled` (default) | The `load` event, then no DOM changes **and** no more than 2 in-flight requests for `quietMs`. A good default for unknown pages. |
| `selector` | An element matching `selector` to become visible. Best when you know the page. |
| `expression` | A JS expression to become truthy. Errors count as "not yet", so `window.app.ready` works before `window.app` exists. |
| `networkidle` | No network activity for 500ms. Never fires on pages that poll, so it relies on the timeout. |
| `load` / `domcontentloaded` | The browser events. |

Timeouts are soft by default: you get the page as it was, plus `X-Wait-Timed-Out: true`. Set `strict: true` to get a 504 instead.

`scrollToLoad` scrolls to the bottom in viewport-sized steps (up to 10 seconds) so lazy images and infinite-scroll content load, then scrolls back to the top before capturing.

## Very tall pages

Screenshots are captured in 4096px tiles and stitched together. That keeps each capture well under Chromium's ~16k-pixel GPU texture size, which is where single-shot captures of tall pages can come out with repeated or blank sections. The limit that matters is `maxHeight` (default and server maximum: `MAX_IMAGE_HEIGHT`, 32768px; WebP can't exceed 16383px). When a page is taller than that, `overflow` decides:

- **`truncate`** (default): the top `maxHeight` pixels, with `X-Truncated: true` and the real `X-Page-Height`.
- **`scale`**: the whole page, shrunk to fit.
- **`tiles`**: a zip of `tileHeight`-pixel images plus `manifest.json` with each tile's position.
- **`error`**: a 422 with the measurements, so the caller can decide.

For very long documents, `format: "pdf"` is often a better fit, because it paginates naturally.

No mode captures more than `MAX_CAPTURE_HEIGHT` (100,000 CSS px), which stops infinite-scroll pages from growing forever.

## Security

- **SSRF.** All of Chromium's traffic goes through a small proxy inside the service. The proxy resolves each hostname itself, refuses anything that isn't a public unicast address (localhost, RFC 1918, link-local / cloud metadata, CGNAT, IPv6 ULA, ...), and then connects to exactly the address it checked. This covers redirects, subresources, iframes, fetch, WebSockets and DNS-rebinding tricks; `page.route` checks miss several of these. WebRTC UDP and QUIC are disabled so nothing bypasses the proxy. Set `ALLOW_PRIVATE_NETWORKS=true` only if you need to render intranet pages and trust every key holder.
- **Defence in depth.** For a second layer, block the container's outbound traffic to private ranges at the host firewall (Docker's `DOCKER-USER` iptables chain). Make sure you don't also block the compose network itself, or Caddy won't be able to reach the API.
- **Keys** are compared in constant time. Use long random ones, and HTTPS (the Caddy profile) whenever the service is reachable over a network.
- **`headers`** are only attached to requests for the target URL's origin, so an `Authorization` header doesn't leak to third-party scripts or CDNs. Cookies follow normal browser scoping.
- **Container.** It runs as a non-root user with a read-only filesystem, all capabilities dropped and `no-new-privileges`. Chromium's own sandbox is off by default (Playwright's default in Docker, because it needs user namespaces). If your host allows it, set `CHROMIUM_SANDBOX=true` and run with [Playwright's seccomp profile](https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json).

## Configuration

| Variable | Default | |
|---|---|---|
| `API_KEYS` | (required) | Comma-separated, each at least 16 characters |
| `PORT` | `3000` | Port inside the container |
| `RENDER_PORT` | `3000` | Host port (docker compose) |
| `MAX_CONCURRENCY` | `2` | Renders in parallel. Chromium idles at about 400 MB; each heavy page can add several hundred MB more. |
| `MAX_QUEUE` | `20` | Requests that may wait for a slot before getting 503 |
| `JOB_TIMEOUT_MS` | `60000` | Hard limit per render (excluding queue time) |
| `NAVIGATION_TIMEOUT_MS` | `30000` | Limit for the initial page load |
| `MAX_IMAGE_HEIGHT` | `32768` | Upper bound for `maxHeight` |
| `MAX_CAPTURE_HEIGHT` | `100000` | Most CSS pixels of a page ever captured |
| `BROWSER_RECYCLE_AFTER` | `200` | Restart Chromium after this many renders |
| `CHROMIUM_SANDBOX` | `false` | See Security |
| `ALLOW_PRIVATE_NETWORKS` | `false` | See Security |
| `LOG_LEVEL` | `info` | |

## Development

```bash
npm install
npx playwright install chromium --no-shell   # add --with-deps on a fresh machine
API_KEYS=dev-key-0123456789abcdef ALLOW_PRIVATE_NETWORKS=true npm run dev
npm test
```

The tests start a local fixture site and drive the real browser end to end: waiting strategies, tile stitching across seams, every overflow mode, every format, auth, timeouts, queue limits, and the SSRF guard (including a control test that proves the same page *does* reach localhost when private networks are allowed). To run them inside the production image:

```bash
docker build -t render-service .
docker run --rm --read-only --tmpfs /tmp --shm-size 1g -v "$PWD/test:/app/test:ro" \
  render-service node --test --test-concurrency=1 "test/**/*.test.js"
```

## Known limitations

- **Inner scroll containers.** Apps that scroll an inner element instead of the page (`body { height: 100vh; overflow: hidden }`) only produce a viewport-sized "full page", and the same goes for PDF. A taller `viewport.height` (up to 4320) is the practical workaround.
- **Width.** Full-page screenshots are the viewport's width; content that overflows sideways is cut off.
- **Bot protection.** Some sites (Cloudflare challenges and similar) block headless browsers. You'll get the challenge page, usually with a 403 in `X-Upstream-Status`.
- **Fonts.** The image covers Latin, CJK, Thai, emoji and most Noto scripts. Add packages to the Dockerfile if you need others.
