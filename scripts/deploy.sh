#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -f .env ]]; then
  echo "No .env in $repo_dir." >&2
  echo "Copy .env.production.example to .env and fill in the required values." >&2
  exit 1
fi

# Releases are swapped with the docker-rollout CLI plugin, which belongs to the
# host rather than to this repository. Check before pulling, so a new server
# fails here, naming the fix, while nothing has changed. Match the output: when
# the plugin is missing, Docker answers `docker rollout --version` with its own
# version and exits 0.
if [[ "$(docker rollout --version 2>/dev/null || true)" != "docker-rollout version "* ]]; then
  echo "The docker-rollout plugin is not installed for $(id -un) on this host." >&2
  echo "Deploying hobby-traefik installs it, or run:" >&2
  echo "  bash ~/projects/hobby-traefik/scripts/install-docker-rollout.sh" >&2
  exit 1
fi

if ! docker network inspect traefik-public >/dev/null 2>&1; then
  echo "The traefik-public network does not exist, so the shared proxy is not running." >&2
  echo "Deploy it first: bash ~/projects/hobby-traefik/scripts/deploy.sh" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing to deploy over tracked changes in $repo_dir" >&2
  exit 1
fi

git pull --ff-only

# What we just pulled has to survive a Windows checkout. A CR in a shell script
# fails as `bad interpreter: ...^M` or `set: pipefail: invalid option name`,
# neither of which names line endings; a lost mode bit fails as `Permission
# denied`. Check here, where the previous release is still serving and nothing
# has been rebuilt yet. `|| true` because grep and awk exit non-zero on no
# match, which is the healthy case.
crlf="$(git ls-files --eol -- '*.sh' | grep -E 'w/(crlf|mixed)' || true)"
if [[ -n "$crlf" ]]; then
  echo "CRLF line endings in tracked scripts:" >&2
  echo "$crlf" >&2
  echo "Commit a .gitattributes, then: git add --renormalize . && git commit" >&2
  exit 1
fi

not_exec="$(git ls-files -s -- '*.sh' | awk '$1 != "100755" {print $4}' || true)"
if [[ -n "$not_exec" ]]; then
  echo "Tracked scripts are not executable:" >&2
  echo "$not_exec" >&2
  echo "Fix with: git update-index --chmod=+x <file>" >&2
  exit 1
fi

compose_args=(--env-file .env -f docker-compose.yml -f docker-compose.traefik.yml -f docker-compose.prod.yml)
compose=(docker compose "${compose_args[@]}")

# Every service must be in exactly one list; see "Decide which services to roll"
# in hobby-traefik's playbook-zero-downtime-deploys.md.
#   before_rollout  what the rolled services need running first (databases)
#   one_shot        jobs that run to completion before the rollout (migrations)
#   rolled          Traefik-routed services, swapped without downtime
#   after_rollout   everything else, updated with a plain `up`
# The render service is the whole application, and it holds nothing between
# requests.
before_rollout=()
one_shot=()
rolled=(render)
after_rollout=()
long_running=("${before_rollout[@]}" "${rolled[@]}" "${after_rollout[@]}")

"${compose[@]}" config --quiet

# A service missing from the lists would be started once and never updated, so a
# service added to Compose later has to be classified before the next deploy.
listed=" ${long_running[*]} ${one_shot[*]} "
for service in $("${compose[@]}" config --services); do
  if [[ "$listed" != *" $service "* ]]; then
    echo "Service '$service' is not in a service list in scripts/deploy.sh." >&2
    exit 1
  fi
done

# Without this every build attaches a fresh provenance attestation, which gives
# an unchanged image a new ID, and the server's Compose (2.40) recreates any
# container whose image ID changed: services that are not rolled restarted on
# every deploy. These images never leave the host, so nothing reads it.
export BUILDX_NO_DEFAULT_ATTESTATIONS=1
"${compose[@]}" build

if (( ${#before_rollout[@]} )); then
  "${compose[@]}" up -d --wait --wait-timeout 90 "${before_rollout[@]}"
fi

# One-shot jobs finish while the previous release is still serving, so
# migrations must stay backward compatible with it. They run through `up` rather
# than `run` so their service container is replaced too: the rollout starts the
# rolled services' dependencies again, and would otherwise re-run the previous
# release's job.
for service in "${one_shot[@]}"; do
  "${compose[@]}" up --no-deps --exit-code-from "$service" "$service"
done

# `up` would stop the running release before starting the new one, and the site
# would be down until the new one passed its health check. docker rollout starts
# the new container beside the old, waits for it to turn healthy, then removes
# the old. A release that never turns healthy is removed instead, the old one
# keeps serving, and the deploy fails.
#
# The pre-stop hook drains the outgoing container first: /tmp/drain fails its
# health check, Traefik stops routing to it, and in-flight requests finish. 20
# seconds covers three failed probes 5 seconds apart plus Traefik noticing.
# Renders still running after that are covered by the service's
# stop_grace_period, not by this sleep.
#
# Unless the routing labels changed. Traefik refuses a service that two
# containers describe differently and serves 404 while both exist, so draining
# would stretch that into a 20-second outage. Stop the old one immediately
# instead and accept a sub-second blip.
routing_labels() { { grep -o '"traefik\.[^"]*": *"[^"]*"' || true; } | sed 's/": *"/":"/' | sort; }
for service in "${rolled[@]}"; do
  rollout=(docker rollout "${compose_args[@]}" --timeout 90)
  running_ids="$("${compose[@]}" ps --quiet "$service")"
  if [[ -n "$running_ids" ]]; then
    live_labels="$(docker inspect --format '{{json .Config.Labels}}' "${running_ids%%$'\n'*}" | routing_labels)"
    new_labels="$("${compose[@]}" config --format json "$service" | routing_labels)"
    if [[ "$live_labels" == "$new_labels" ]]; then
      rollout+=(--pre-stop-hook 'touch /tmp/drain && sleep 20')
    else
      echo "Routing labels of $service changed; replacing its old container without draining it."
    fi
  fi
  "${rollout[@]}" "$service"
done

# --no-deps, so a worker that depends_on a rolled service cannot recreate it.
if (( ${#after_rollout[@]} )); then
  "${compose[@]}" up -d --no-deps --wait --wait-timeout 90 "${after_rollout[@]}"
fi

# Removes containers of services no longer in the Compose files and confirms
# every long-running service is healthy. Naming them with --no-deps keeps it from
# re-running one-shot jobs or waiting on their exited containers, and
# --no-recreate stops it replacing what was just rolled.
"${compose[@]}" up -d --no-deps --no-recreate --remove-orphans --wait --wait-timeout 90 "${long_running[@]}"
"${compose[@]}" ps
