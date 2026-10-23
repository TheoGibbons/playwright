# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim

# Chromium writes its config/crash database under XDG dirs; pointing them at
# /tmp lets the container run with a read-only root filesystem, which is also
# all Lambda provides.
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    XDG_CONFIG_HOME=/tmp/.config \
    XDG_CACHE_HOME=/tmp/.cache

WORKDIR /app

COPY package.json package-lock.json ./

# Chromium plus the system libraries and fonts it needs (the --with-deps set
# covers Latin, CJK, Thai and colour emoji; fonts-noto-core adds most other
# scripts so pages don't render as empty boxes). tini reaps orphaned Chromium
# processes, which Node would otherwise leave as zombies.
RUN npm ci --omit=dev \
 && npx playwright install --with-deps --no-shell chromium \
 && apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-core tini \
 && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

# On Lambda, the AWS Lambda Web Adapter turns each invocation into an HTTP
# request to the server below, so the image runs there unchanged. Lambda starts
# whatever is in /opt/extensions; anywhere else the adapter is never run.
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0 /lambda-adapter /opt/extensions/lambda-adapter

RUN useradd --create-home --uid 10001 app
COPY src ./src

# Lambda ignores USER and runs the image as its own non-root user.
USER app
EXPOSE 3000

# /healthz needs no key, has no side effects and never launches Chromium. The
# image has neither wget nor curl, so Node makes the request. Lambda ignores
# HEALTHCHECK; the adapter waits for /healthz instead (infra/app.yml).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Lambda skips tini and runs node itself (ImageConfig in infra/app.yml): its
# own init is PID 1 there, and it forbids tini to register as a subreaper.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
