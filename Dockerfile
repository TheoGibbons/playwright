# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim

# Chromium writes its config/crash database under XDG dirs; pointing them at
# /tmp lets the container run with a read-only root filesystem.
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
# processes, which Node as PID 1 would leave as zombies.
RUN npm ci --omit=dev \
 && npx playwright install --with-deps --no-shell chromium \
 && apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-core tini \
 && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

RUN useradd --create-home --uid 10001 app
COPY src ./src

USER app
EXPOSE 3000

# /healthz needs no key, has no side effects and never launches Chromium, so
# probing it cannot keep an idle browser alive. The image has neither wget nor
# curl, so Node makes the request.
#
# Traefik routes only to a healthy container, so these timings are what make a
# LIVE deploy seamless (scripts/deploy.sh). --start-interval probes every second
# while booting, so a new release takes traffic as soon as it answers. The short
# --interval and the /tmp/drain check let a deploy take the outgoing release out
# of rotation within 15 seconds, before it is stopped.
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --start-interval=1s --retries=3 \
  CMD test ! -f /tmp/drain && node -e "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
