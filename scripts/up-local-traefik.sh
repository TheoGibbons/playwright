#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -f .env ]]; then
  cp .env.traefik.example .env
fi

if ! docker network inspect traefik-public >/dev/null 2>&1; then
  echo "The traefik-public network is missing. Start hobby-traefik locally first." >&2
  exit 1
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

compose=(docker compose --env-file .env -f docker-compose.yml -f docker-compose.traefik.yml)
"${compose[@]}" config --quiet
"${compose[@]}" up -d --build --remove-orphans --wait --wait-timeout 90
"${compose[@]}" ps

set -a
# shellcheck disable=SC1091
source .env
set +a
echo "API: http://${APP_HOST:-render.localhost}:8085 (key in API_KEYS in .env)"
