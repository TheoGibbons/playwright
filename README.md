# render-service

A small HTTP API that loads a URL in headless Chromium (Playwright), waits for the page's JavaScript to finish, and returns a **full-page screenshot** (PNG, JPEG or WebP, with a choice of what happens when the page is too tall), a **PDF**, the **rendered HTML** or a self-contained **MHTML** archive. It is protected by API keys and runs on AWS Lambda behind CloudFront, with a monthly spend limit that switches it off. The same Docker image runs locally.

## Using

```bash
KEY=<the API_KEYS>
curl -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"url":"https://example.com"}' -o page.png https://playwright.sinkmailer.com/render
```

## Deploying to AWS Lambda

`scripts/deploy.sh` builds the image, checks that it starts and launches Chromium, pushes it, and deploys two CloudFormation stacks in us-east-1:

- **`playwright-ecr`**: the image repository (`infra/ecr.yml`).
- **`playwright`** (`infra/app.yml`): the function `playwright-render`, its function URL, a CloudFront distribution with a certificate for `DOMAIN_NAME`, and the [spend limit](#spend-limit).

Everything is in us-east-1 because CloudFront only accepts certificates from there. Each Lambda instance renders one page at a time, and Lambda starts more instances, up to `LAMBDA_MAX_INSTANCES`, as requests arrive. A deploy ends once the new release answers `/healthz`. If it doesn't, the script puts the previous image back and exits non-zero.

You need Docker, and the AWS CLI signed in (`aws login`) to the account that holds the `sinkmailer.com` hosted zone.

### First deploy

**1. Deploy.**

```bash
git clone https://github.com/TheoGibbons/playwright.git ~/projects/playwright
cd ~/projects/playwright
cp .env.production.example .env.production

# Set before continuing:
#   API_KEYS        one or more comma-separated keys of 16+ characters;
#                   generate one with: openssl rand -hex 32
#   HOSTED_ZONE_ID  find it with:
#                   aws route53 list-hosted-zones-by-name --dns-name sinkmailer.com \
#                     --query "HostedZones[?Name=='sinkmailer.com.'].Id" --output text
#   ALERT_EMAIL     optional: who is emailed at 80% and 100% of the budget
nano .env.production

bash scripts/deploy.sh
```

The first run takes 5 to 15 minutes, most of it the certificate and the CloudFront distribution. It ends by printing the CloudFront domain.

**2. Try it through CloudFront** before any DNS changes. The distribution also answers on its own domain:

```bash
CF=$(aws cloudformation describe-stacks --region us-east-1 --stack-name playwright \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomain'].OutputValue" --output text)
KEY=$(grep '^API_KEYS=' .env.production | cut -d= -f2 | cut -d, -f1)

curl -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}' -o page.png "https://$CF/render"
```

**3. Point the hostname at CloudFront.** `UPSERT` replaces the existing record in place, so the hostname never stops resolving. Clients follow it within the old record's TTL.

```bash
CF=$(aws cloudformation describe-stacks --region us-east-1 --stack-name playwright \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomain'].OutputValue" --output text)
ZONE=$(grep '^HOSTED_ZONE_ID=' .env.production | cut -d= -f2)
NAME=$(grep '^DOMAIN_NAME=' .env.production | cut -d= -f2)

# Z2FDTNDATAQYW2 is the hosted zone of every CloudFront distribution.
aws route53 change-resource-record-sets --hosted-zone-id "${ZONE#/hostedzone/}" --change-batch "{\"Changes\": [
  {\"Action\": \"UPSERT\", \"ResourceRecordSet\": {\"Name\": \"$NAME\", \"Type\": \"A\",
    \"AliasTarget\": {\"HostedZoneId\": \"Z2FDTNDATAQYW2\", \"DNSName\": \"$CF\", \"EvaluateTargetHealth\": false}}},
  {\"Action\": \"UPSERT\", \"ResourceRecordSet\": {\"Name\": \"$NAME\", \"Type\": \"AAAA\",
    \"AliasTarget\": {\"HostedZoneId\": \"Z2FDTNDATAQYW2\", \"DNSName\": \"$CF\", \"EvaluateTargetHealth\": false}}}
]}"
```

These records are not part of the stack, so deploys never touch them.

**4. Activate the cost allocation tag, a day later.** The budget counts only resources tagged `project=playwright`, and AWS ignores a tag until it has been activated. A new tag reaches billing data up to 24 hours after the resources carrying it are created, and until then this fails with a "tag not found" error:

```bash
aws ce update-cost-allocation-tags-status --region us-east-1 \
  --cost-allocation-tags-status TagKey=project,Status=Active
```

Until the tag is active, the budget reads $0 and the spend limit never trips. The Billing console's **Cost allocation tags** page does the same thing.

### Later deploys

```bash
bash scripts/deploy.sh
```

This deploys the checked-out commit along with whatever is in `.env.production`. It refuses uncommitted changes to anything that goes into the image or the stacks, because the image is tagged with the commit. Delete a line from `.env.production` and deploy to get the default back. A blank `API_KEYS` keeps the keys that are already deployed.

### Push-to-deploy

A push to `main` runs `.github/workflows/deploy.yml`, which runs `bash scripts/deploy.sh --code-only`. That deploys the new image and keeps the deployed template and settings. GitHub holds no AWS keys: the workflow signs in through GitHub's OIDC provider, as a role that can push to the image repository and point the function at a new image, and nothing else. So changes to `infra/` or `.env.production` still need `bash scripts/deploy.sh` from your machine; the workflow warns when `infra/app.yml` differs from what is deployed. The workflow is skipped until the steps below are done.

**Part 1 — once per AWS account.** Skip it if another project in the account already deploys from GitHub Actions. An `EntityAlreadyExists` error means it is done.

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com
```

**Part 2 — once per repository.**

```bash
cd ~/projects/playwright
aws cloudformation deploy --region us-east-1 --stack-name playwright-github-deploy \
  --template-file infra/github-deploy.yml --capabilities CAPABILITY_IAM --tags project=playwright

# The role only trusts jobs in this GitHub environment. Creating one that exists is harmless.
gh api -X PUT repos/TheoGibbons/playwright/environments/production >/dev/null
gh variable set AWS_DEPLOY_ROLE_ARN --body "$(aws cloudformation describe-stacks --region us-east-1 \
  --stack-name playwright-github-deploy --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" --output text)"
```

## Spend limit

AWS has no hard spending cap, so the stack switches the API off instead:

1. An AWS Budget tracks this calendar month's cost of everything tagged `project=playwright`: the function, CloudFront, the image repository and the logs.
2. When actual cost passes `MONTHLY_BUDGET_USD` (default $5), the budget notifies an SNS topic. The `playwright-spend-guard` function then sets the render function's reserved concurrency to 0. From then on every request gets 429 from Lambda, and nothing more is billed for compute.
3. At 00:05 UTC on the 1st, a schedule sets the concurrency back to `LAMBDA_MAX_INSTANCES`.

With `ALERT_EMAIL` set, the budget also emails at 80% and 100%.

**How far past the limit it can go.** Budgets sees costs late: AWS refreshes billing data a few times a day, so the switch-off can land up to about a day after the limit is crossed. `LAMBDA_MAX_INSTANCES` limits how much can be spent in that time. One instance busy non-stop at 2048 MB costs about $0.12 an hour (x86, us-east-1), so the default of 2 can overshoot by a few dollars in the worst case. A flood of requests with wrong keys costs more per hour than renders do, because Lambda also bills per request; plan for about $1 an hour at worst. Set `LAMBDA_MAX_INSTANCES=1` to halve either figure.

**What normal use costs.** Usually nothing beyond storage. Lambda's free tier covers 400,000 GB-seconds and 1 million requests a month, which is about 55 hours of rendering at 2048 MB. CloudFront's free tier covers 1 TB and 10 million requests. Usage inside a free tier costs $0, so it never counts toward the budget. What remains is a few cents a month: image storage (about 0.4 GB per image, three kept) and logs.

**Making CloudFront unbillable.** You can also put the distribution on CloudFront's flat-rate **Free** plan: CloudFront console, the distribution, then *Pricing plan*. A distribution on a plan is never billed overages, and requests that AWS WAF blocks don't count toward its allowance. The plan attaches an AWS WAF web ACL, to which you can add rules such as rate limiting. Copy that web ACL's ARN into `CLOUDFRONT_WEB_ACL_ARN` and deploy, or the next deploy that touches the distribution detaches it.

**Switching it back on early**, for example after raising `MONTHLY_BUDGET_USD`. Raising the budget doesn't switch the API back on by itself:

```bash
aws lambda put-function-concurrency --region us-east-1 --function-name playwright-render \
  --reserved-concurrent-executions 2   # LAMBDA_MAX_INSTANCES
```

## Running locally

Needs only Docker. The API is published on loopback only.

```bash
git clone https://github.com/TheoGibbons/playwright.git ~/projects/playwright
cd ~/projects/playwright
cp .env.example .env
sed -i "s/^API_KEYS=$/API_KEYS=$(openssl rand -hex 32)/" .env

docker compose up -d --build --wait
```

The API is at <http://localhost:3000>; see [To try it](#to-try-it). This runs the same image as Lambda, but as a long-running server: it uses the local-only settings in [Configuration](#configuration), and nothing in front of it.

## To try it

With the service running locally (see [Running locally](#running-locally)):

```bash
KEY=$(grep '^API_KEYS=' .env | cut -d= -f2 | cut -d, -f1)

curl -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}' -o page.png localhost:3000/render
```

For a PDF send `'{"url":"...","format":"pdf"}'`, or use `"format":"html"` for the rendered HTML.

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

Errors from the service are JSON: `{"error": "<code>", "message": "..."}`.

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_request` | Bad body, bad URL, invalid selector or expression |
| 401 | `unauthorized` | Missing or wrong API key |
| 403 | `blocked_address` | The URL, or a redirect, points at a private or internal address |
| 422 | `page_too_tall` | `overflow: "error"` and the page exceeds `maxHeight` (includes `pageHeight`, `maxHeight`) |
| 502 | `navigation_failed`, `dns_failed` | The site couldn't be loaded |
| 503 | `queue_full` | Locally only: too many requests waiting; has `Retry-After` |
| 504 | `navigation_timeout`, `wait_timeout`, `job_timeout` | Something took too long |

On Lambda, two more come from AWS and aren't JSON in this shape: **429** when more than `LAMBDA_MAX_INSTANCES` requests are in progress at once or the [spend limit](#spend-limit) has switched the API off, and **504** from CloudFront when nothing came back within 60 seconds.

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

Chromium is started at boot, so a broken install fails immediately rather than on the first request.

**Locally**, it is closed after `IDLE_SHUTDOWN_MS` without renders, and the next request launches it again. Concurrent requests share that one launch. The idle container drops to roughly the Node process alone, and the first render after an idle period pays the browser's start-up time. Set `IDLE_SHUTDOWN_MS=0` if you'd rather trade memory for that latency.

**On Lambda**, Chromium stays up for the life of an instance. Lambda freezes an instance between requests and bills nothing while it is frozen, so closing the browser would save nothing. The cost moves to cold starts instead: the first request to a new instance waits a few seconds for Chromium to launch. That happens after a deploy, when traffic needs another instance, and when Lambda retires an instance that has been idle.

## Security

- **SSRF.** All of Chromium's traffic goes through a small proxy inside the service. The proxy resolves each hostname itself, refuses anything that isn't a public unicast address (localhost, RFC 1918, link-local / cloud metadata, CGNAT, IPv6 ULA, ...), and then connects to exactly the address it checked. This covers redirects, subresources, iframes, fetch, WebSockets and DNS-rebinding tricks; `page.route` checks miss several of these. WebRTC UDP and QUIC are disabled so nothing bypasses the proxy. On Lambda it also keeps pages away from the Lambda Runtime API on `127.0.0.1:9001`, through which a page could otherwise read or answer other requests. That is why the Lambda stack never passes `ALLOW_PRIVATE_NETWORKS`. Set it locally only, to render intranet pages, and only if you trust every key holder.
- **AWS permissions.** The render function's role can write its own logs and nothing else, so even a page that escaped Chromium would find no AWS access worth having. The push-to-deploy role can only ship images.
- **Keys** are compared in constant time. Use long random ones. CloudFront serves HTTPS only (TLS 1.2+). The function's own `lambda-url` address is public too: limiting a function URL to CloudFront would make every caller sign request bodies. The keys protect both addresses equally.
- **`headers`** are only attached to requests for the target URL's origin, so an `Authorization` header doesn't leak to third-party scripts or CDNs. Cookies follow normal browser scoping.
- **Isolation.** On Lambda every instance is its own microVM with a read-only filesystem apart from `/tmp`, running as an unprivileged user. Locally the container runs as a non-root user with a read-only filesystem, all capabilities dropped and `no-new-privileges`. Chromium's own sandbox is off by default (Playwright's default in Docker, because it needs user namespaces), and Lambda can't run it at all. Locally, if your host allows it, set `CHROMIUM_SANDBOX=true` and run with [Playwright's seccomp profile](https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json).

## Configuration

Blank or absent means the default. Locally, set these in `.env`. For Lambda, set them in `.env.production` and run `bash scripts/deploy.sh`.

**Both:**

| Variable | Default | |
|---|---|---|
| `API_KEYS` | (required) | Comma-separated, each at least 16 characters |
| `JOB_TIMEOUT_MS` | `60000`, `50000` on Lambda | Hard limit per render (excluding queue time). On Lambda the answer has to beat CloudFront's 60-second origin timeout, cold start included. Going higher needs a CloudFront quota increase, and `OriginReadTimeout` and `Timeout` raised in `infra/app.yml` |
| `NAVIGATION_TIMEOUT_MS` | `30000` | Limit for the initial page load |
| `MAX_IMAGE_HEIGHT` | `32768` | Upper bound for `maxHeight` |
| `MAX_CAPTURE_HEIGHT` | `100000` | Most CSS pixels of a page ever captured |
| `BROWSER_RECYCLE_AFTER` | `200` | Restart Chromium after this many renders |
| `LOG_LEVEL` | `info` | |

**Lambda only** (`.env.production`):

| Variable | Default | |
|---|---|---|
| `DOMAIN_NAME` | `playwright.sinkmailer.com` | Public hostname. CloudFront serves it with a certificate validated through `HOSTED_ZONE_ID` |
| `HOSTED_ZONE_ID` | (required) | Route 53 hosted zone that holds `DOMAIN_NAME` |
| `MONTHLY_BUDGET_USD` | `5` | Monthly cost at which the API is switched off; see [Spend limit](#spend-limit) |
| `ALERT_EMAIL` | | Emailed at 80% and 100% of the budget |
| `LAMBDA_MAX_INSTANCES` | `2` | Instances that may run at once, each rendering one page; more simultaneous requests get 429. Also limits how fast money can be spent |
| `LAMBDA_MEMORY_MB` | `2048` | Memory per instance; Lambda allocates CPU in proportion, a full vCPU at 1769 MB. Chromium idles at about 400 MB, and a heavy page can add several hundred more |
| `CLOUDFRONT_WEB_ACL_ARN` | | Only with a CloudFront flat-rate plan; see [Spend limit](#spend-limit) |

**Local only** (`.env`):

| Variable | Default | |
|---|---|---|
| `RENDER_PORT` | `3000` | Host port, on 127.0.0.1 |
| `MAX_CONCURRENCY` | `2` | Renders in parallel. Chromium idles at about 400 MB; each heavy page can add several hundred MB more |
| `MAX_QUEUE` | `20` | Requests that may wait for a slot before getting 503 |
| `IDLE_SHUTDOWN_MS` | `60000` | Close Chromium after this long without renders; see [Idle memory](#idle-memory). `0` keeps it running. Always `0` on Lambda |
| `CHROMIUM_SANDBOX` | `false` | See Security |
| `ALLOW_PRIVATE_NETWORKS` | `false` | See Security |
| `PORT` | `3000` | Port inside the container. Only matters when running outside Docker |

## Operating it

```bash
aws logs tail /aws/lambda/playwright-render --follow --region us-east-1         # renders
aws logs tail /aws/lambda/playwright-spend-guard --since 31d --region us-east-1  # spend limit switching
aws lambda get-function-concurrency --function-name playwright-render --region us-east-1
                                       # 0 means the spend limit has switched it off
```

To try the spend limit, switch the API off and back on as the budget and the monthly schedule would:

```bash
aws lambda invoke --region us-east-1 --function-name playwright-spend-guard \
  --cli-binary-format raw-in-base64-out --payload '{"Records": []}' /dev/null   # off
aws lambda invoke --region us-east-1 --function-name playwright-spend-guard \
  --cli-binary-format raw-in-base64-out --payload '{}' /dev/null                # on
```

To roll back, check out the earlier commit and run `bash scripts/deploy.sh`, or revert the commit and push.

Nothing is stored: there are no volumes or databases and nothing to back up. To remove the service, first point `DOMAIN_NAME` elsewhere or delete its A and AAAA records, then:

```bash
aws cloudformation delete-stack --region us-east-1 --stack-name playwright
aws cloudformation wait stack-delete-complete --region us-east-1 --stack-name playwright
aws cloudformation delete-stack --region us-east-1 --stack-name playwright-ecr
aws cloudformation delete-stack --region us-east-1 --stack-name playwright-github-deploy  # if created
```

Locally, `docker compose logs -f render` and `docker compose ps`. `GET /healthz` is what the container's health check, Lambda's readiness check and `scripts/deploy.sh` rely on. It does not launch Chromium, so it does not stop an idle browser from shutting down.

## Development

```bash
npm install
npx playwright install chromium --no-shell   # add --with-deps on a fresh machine
API_KEYS=dev-key-0123456789abcdef ALLOW_PRIVATE_NETWORKS=true npm run dev
npm test
```

The tests start a local fixture site and drive the real browser end to end: waiting strategies, tile stitching across seams, every overflow mode, every format, auth, timeouts, queue limits, and the SSRF guard (including a control test that proves the same page *does* reach localhost when private networks are allowed). To run them inside the image that Lambda runs:

```bash
docker build -t render-service .
docker run --rm --read-only --tmpfs /tmp --shm-size 1g -v "$PWD/test:/app/test:ro" \
  render-service node --test --test-concurrency=1 "test/**/*.test.js"
```

## Known limitations

- **Inner scroll containers.** Apps that scroll an inner element instead of the page (`body { height: 100vh; overflow: hidden }`) only produce a viewport-sized "full page", and the same goes for PDF. A taller `viewport.height` (up to 4320) is the practical workaround.
- **Width.** Full-page screenshots are the viewport's width; content that overflows sideways is cut off.
- **Lambda limits.** A response can be up to 200 MB, Lambda's limit for streamed responses. Lambda sends the first 6 MB at full speed and throttles the rest, so very large images take noticeably longer to arrive. Simultaneous requests beyond `LAMBDA_MAX_INSTANCES` get 429 instead of queueing, so retry them after a moment.
- **Bot protection.** Some sites (Cloudflare challenges and similar) block automated browsers. You'll get the challenge page, usually with a 403 in `X-Upstream-Status`. The service removes the two plainest signs: the user agent says `Chrome` rather than `HeadlessChrome`, and `navigator.webdriver` is `false`. Other signs remain, and running Chromium with a window (under Xvfb) would not remove them: the datacenter IP address (AWS's, on Lambda), WebGL rendered in software (SwiftShader), and traces of the automation protocol. If you set `userAgent` yourself, match the real browser. Use Chrome's shortened form (`Chrome/<major>.0.0.0`) with the same major version, because pages also receive `Sec-CH-UA` client hints that name the real version.
- **Fonts.** The image covers Latin, CJK, Thai, emoji and most Noto scripts. Add packages to the Dockerfile if you need others.
