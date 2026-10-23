# render-service

A small HTTP API that loads a URL in headless Chromium (Playwright), waits for the page's JavaScript to finish, and returns a **full-page screenshot** (PNG, JPEG or WebP, with a choice of what happens when the page is too tall), a **PDF**, the **rendered HTML** or a self-contained **MHTML** archive. It is protected by API keys and runs as a single Docker container.

## Using

```bash
KEY=<the API_KEYS>
curl -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"url":"https://example.com"}' -o page.png https://playwright.sinkmailer.com/render
```

## Deploying to LIVE

Needs nothing but Docker. This path publishes the API on port 80 and **TLS is your job**: put Cloudflare, nginx or Caddy in front of it. Every request carries an API key in a header, and plain HTTP puts that key on the wire in clear text.

```bash
git clone https://github.com/TheoGibbons/playwright.git ~/projects/playwright
cd ~/projects/playwright
cp .env.production.example .env

# Set before continuing:
#   API_KEYS  one or more comma-separated keys of 16+ characters;
#             generate one with: openssl rand -hex 32
#   APP_BIND=0.0.0.0  APP_PORT=80   <- publishes publicly instead of on loopback
nano .env

docker compose up -d --build
```

| TCP port | Allowed source | Purpose |
|---|---|---|
| 22 | Administrator IP | SSH and deployment |
| 80 | Public internet | API, behind your own TLS terminator |

## Deploying to LIVE with hobby-traefik

Requires the shared proxy. If it is not running on this instance yet:

```bash
git clone https://github.com/TheoGibbons/hobby-traefik.git ~/projects/hobby-traefik
cd ~/projects/hobby-traefik
bash scripts/deploy.sh
```

Point `APP_HOST`'s DNS record at this instance **before** deploying, or Let's Encrypt cannot validate it. Then:

```bash
git clone https://github.com/TheoGibbons/playwright.git ~/projects/playwright
cd ~/projects/playwright
cp .env.production.example .env

# Set before continuing:
#   API_KEYS  one or more comma-separated keys of 16+ characters;
#             generate one with: openssl rand -hex 32
#   APP_HOST  public DNS name, already pointing at this instance
nano .env

bash scripts/deploy.sh
```

On this path HTTPS comes from the production overlay and only Traefik publishes a host port. The security group needs 22, 80 and 443 open, which hobby-traefik already documents.

Deploys on this path do not take the API down. The script starts the new release beside the old one with the [docker-rollout](https://github.com/wowu/docker-rollout) CLI plugin, waits for it to pass its health check, lets Traefik drain the old one, then stops it. Renders still running on the old release finish first. A release that never turns healthy is discarded and the old one keeps serving. Deploying hobby-traefik installs the plugin; the script stops before pulling, with the install command, on a server that lacks it.

## Deploying Locally

Needs only Docker. Nothing is published beyond loopback.

```bash
git clone https://github.com/TheoGibbons/playwright.git ~/projects/playwright
cd ~/projects/playwright
cp .env.example .env

bash scripts/up-local.sh
```

The script generates an API key into the blank `API_KEYS` the first time. The API is at <http://localhost:3088>; see [To try it](#to-try-it).

## Deploying Locally with hobby-traefik

Start the shared proxy first if it is not already running:

```bash
git clone https://github.com/TheoGibbons/hobby-traefik.git ~/projects/hobby-traefik
cd ~/projects/hobby-traefik
cp .env.example .env
bash scripts/up-local.sh
```

Then:

```bash
git clone https://github.com/TheoGibbons/playwright.git ~/projects/playwright
cd ~/projects/playwright
cp .env.traefik.example .env

bash scripts/up-local-traefik.sh
```

The script generates an API key into the blank `API_KEYS` the first time. The API is at <http://render.localhost:8085>; any `*.localhost` name resolves without DNS.

## Setup push-to-deploy

A push to `main` deploys to EC2 through `.github/workflows/deploy.yml`.

**Part 1 — once per server, not once per project.** Skip if another project on this instance has already done it. Public repositories can skip it entirely.

```bash
# On the EC2 instance. Create a fine-grained PAT with Contents: Read-only,
# scoped to the repositories this box deploys:
#   https://github.com/settings/personal-access-tokens
read -rsp 'PAT: ' PAT && echo

git config --global credential.helper store
printf 'https://x-access-token:%s@github.com\n' "$PAT" > ~/.git-credentials
chmod 600 ~/.git-credentials
```

A deploy key cannot be shared: GitHub binds one to a single repository and rejects the same key on a second with "Key is already in use". The PAT has no such limit.

**Part 2 — once per repository.** The same EC2 keypair is reused for every project, so only these four secrets are new. Create a GitHub environment named `production`, then:

```bash
# Locally, with the gh CLI authenticated:
gh secret set EC2_HOST            --env production --body '<ec2-public-dns>'
gh secret set EC2_USER            --env production --body 'ubuntu'
gh secret set EC2_SSH_PRIVATE_KEY --env production < ~/.ssh/<ec2-deploy-key>
gh secret set EC2_KNOWN_HOSTS     --env production \
  --body "$(ssh-keyscan -H <ec2-public-dns> 2>/dev/null)"
```

The deploy stops rather than overwrite tracked files edited directly on the server, and stops if the pulled checkout has CRLF line endings or a script that lost its executable bit. Commit through Git instead of letting the live and local copies drift.

A push deploys with the `scripts/deploy.sh` already on the server, which then pulls. A change to the script itself therefore takes effect from the deploy after the one that ships it.

## To try it

With the service running locally (see [Deploying Locally](#deploying-locally)):

```bash
KEY=$(grep '^API_KEYS=' .env | cut -d= -f2 | cut -d, -f1)

curl -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}' -o page.png localhost:3088/render
```

Through the local proxy, use `render.localhost:8085/render` instead. For a PDF send `'{"url":"...","format":"pdf"}'`, or use `"format":"html"` for the rendered HTML.

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
  "userAgent": "...",            // default: Chromium's own, without "Headless" (see Known limitations)

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

Unauthenticated. Reports browser and queue state. `browser.running` is `false` while Chromium is stopped for being idle; that's normal, and the endpoint still returns 200.

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

## Idle memory

Chromium is started at boot, so a broken install fails immediately rather than on the first request. After `IDLE_SHUTDOWN_MS` without renders it is closed, and the next request launches it again. Concurrent requests share that one launch. This suits occasional use: the idle container drops to roughly the Node process alone, and the first render after an idle period pays the browser's start-up time. Set `IDLE_SHUTDOWN_MS=0` if you'd rather trade memory for that latency.

## Security

- **SSRF.** All of Chromium's traffic goes through a small proxy inside the service. The proxy resolves each hostname itself, refuses anything that isn't a public unicast address (localhost, RFC 1918, link-local / cloud metadata, CGNAT, IPv6 ULA, ...), and then connects to exactly the address it checked. This covers redirects, subresources, iframes, fetch, WebSockets and DNS-rebinding tricks; `page.route` checks miss several of these. WebRTC UDP and QUIC are disabled so nothing bypasses the proxy. That also keeps pages away from the other containers on `traefik-public`. Set `ALLOW_PRIVATE_NETWORKS=true` only if you need to render intranet pages and trust every key holder.
- **Defence in depth.** For a second layer, block the container's outbound traffic to private ranges at the host firewall (Docker's `DOCKER-USER` iptables chain). Make sure you don't also block the Docker networks the container sits on, or Traefik (or your own TLS terminator) won't be able to reach the API.
- **Keys** are compared in constant time. Use long random ones, and HTTPS whenever the service is reachable over a network: the hobby-traefik path provides it, and standalone LIVE needs a terminator in front.
- **`headers`** are only attached to requests for the target URL's origin, so an `Authorization` header doesn't leak to third-party scripts or CDNs. Cookies follow normal browser scoping.
- **Container.** It runs as a non-root user with a read-only filesystem, all capabilities dropped and `no-new-privileges`. Chromium's own sandbox is off by default (Playwright's default in Docker, because it needs user namespaces). If your host allows it, set `CHROMIUM_SANDBOX=true` and run with [Playwright's seccomp profile](https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json).

## Configuration

Set these in `.env`. Blank or absent means the default.

| Variable | Default | |
|---|---|---|
| `API_KEYS` | (required) | Comma-separated, each at least 16 characters. Compose refuses to start without it |
| `APP_BIND` | `127.0.0.1` | Host address the API is published on, standalone only. `0.0.0.0` for standalone LIVE |
| `APP_PORT` | `3088` | Host port, standalone only. `80` for standalone LIVE |
| `APP_HOST` | (required with Traefik) | Hostname Traefik routes to the API, e.g. `render.localhost` locally |
| `MAX_CONCURRENCY` | `2` | Renders in parallel. Chromium idles at about 400 MB; each heavy page can add several hundred MB more. |
| `MAX_QUEUE` | `20` | Requests that may wait for a slot before getting 503 |
| `JOB_TIMEOUT_MS` | `60000` | Hard limit per render (excluding queue time). Raising it means raising `stop_grace_period` in `docker-compose.yml` too, or a deploy cuts off the longest renders |
| `NAVIGATION_TIMEOUT_MS` | `30000` | Limit for the initial page load |
| `MAX_IMAGE_HEIGHT` | `32768` | Upper bound for `maxHeight` |
| `MAX_CAPTURE_HEIGHT` | `100000` | Most CSS pixels of a page ever captured |
| `BROWSER_RECYCLE_AFTER` | `200` | Restart Chromium after this many renders |
| `IDLE_SHUTDOWN_MS` | `60000` | Close Chromium after this long without renders; the next request starts it again (see [Idle memory](#idle-memory)). `0` keeps it running. |
| `CHROMIUM_SANDBOX` | `false` | See Security |
| `ALLOW_PRIVATE_NETWORKS` | `false` | See Security |
| `LOG_LEVEL` | `info` | |
| `PORT` | `3000` | Port inside the container. Fixed at 3000 by `docker-compose.yml`; only matters when running outside Docker |

## Operating it

```bash
docker compose logs -f render                 # standalone
docker compose ps
```

Add `-f docker-compose.yml -f docker-compose.traefik.yml` (plus `-f docker-compose.prod.yml` on the server) to operate a Traefik-integrated stack. The scripts pass those explicitly so Compose never merges the standalone override in by accident. Container names change on every LIVE deploy (`playwright-render-1`, then `-2`, ...), so always go through `docker compose ... logs render` rather than a container name.

Nothing is stored: there are no volumes and nothing to back up.

During a LIVE deploy the old and new releases run side by side for up to half a minute, plus however long the old one's in-flight renders take. Leave memory for two containers, each capped at 2 GB by `mem_limit`.

`GET /healthz` is the health check the container and deploys rely on. It does not launch Chromium, so it does not stop an idle browser from shutting down.

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
- **Bot protection.** Some sites (Cloudflare challenges and similar) block automated browsers. You'll get the challenge page, usually with a 403 in `X-Upstream-Status`. The service removes the two plainest signs: the user agent says `Chrome` rather than `HeadlessChrome`, and `navigator.webdriver` is `false`. Other signs remain, and running Chromium with a window (under Xvfb) would not remove them: the server's datacenter IP address, WebGL rendered in software (SwiftShader), and traces of the automation protocol. If you set `userAgent` yourself, match the real browser. Use Chrome's shortened form (`Chrome/<major>.0.0.0`) with the same major version, because pages also receive `Sec-CH-UA` client hints that name the real version.
- **Fonts.** The image covers Latin, CJK, Thai, emoji and most Noto scripts. Add packages to the Dockerfile if you need others.
