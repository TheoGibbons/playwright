#!/usr/bin/env bash
set -Eeuo pipefail

# Standalone local run: no proxy, no shared Docker network, loopback port only.
# Plain `docker compose` automatically merges docker-compose.override.yml, which
# is where that host port lives.

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

# The example ships API_KEYS blank so that no working key is ever committed, and
# the service refuses to start without one. Generate a key the first time. The
# rewrite goes through cat so .env keeps its permissions.
if grep -q '^API_KEYS=$' .env; then
  key="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  tmp="$(mktemp)"
  sed "s/^API_KEYS=\$/API_KEYS=$key/" .env > "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
  echo "Generated an API key into API_KEYS in .env."
fi

compose=(docker compose --env-file .env)
"${compose[@]}" config --quiet
# --wait so this returns only once the service is healthy. The README documents
# no separate verification step and relies on that.
"${compose[@]}" up -d --build --remove-orphans --wait --wait-timeout 90
"${compose[@]}" ps

set -a
# shellcheck disable=SC1091
source .env
set +a
echo "API: http://localhost:${APP_PORT:-3088} (key in API_KEYS in .env)"
