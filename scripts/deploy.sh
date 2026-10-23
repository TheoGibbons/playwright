#!/usr/bin/env bash
set -Eeuo pipefail

# Deploys the render service to AWS Lambda, behind CloudFront.
#
#   bash scripts/deploy.sh              the image, the infrastructure and the
#                                       settings in .env.production
#   bash scripts/deploy.sh --code-only  only a new image; everything else stays
#                                       as deployed. Push-to-deploy runs this.
#
# Either way it ends with the new release answering /healthz, or with the
# previous release restored and a non-zero exit.

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

case "${1:-}" in
  '') code_only=false ;;
  --code-only) code_only=true ;;
  *)
    echo "Usage: bash scripts/deploy.sh [--code-only]" >&2
    exit 2
    ;;
esac

if [[ $code_only == false ]]; then
  if [[ ! -f .env.production ]]; then
    echo "No .env.production in $repo_dir." >&2
    echo "Copy .env.production.example to .env.production and fill in the required values." >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1091
  source .env.production
  set +a
fi

# CloudFront only accepts certificates from us-east-1, so the whole service
# lives there and one stack holds it.
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
stack=playwright
function_name=playwright-render # fixed in infra/app.yml
repository=playwright           # fixed in infra/ecr.yml
# The spend limit's budget counts whatever carries this tag.
tags=(project=playwright)

# The image is tagged with the commit, so the commit has to be what is built.
if [[ -n "$(git status --porcelain -- Dockerfile .dockerignore package.json package-lock.json src infra)" ]]; then
  echo "Refusing to deploy: Dockerfile, the package files, src/ or infra/ have uncommitted changes." >&2
  exit 1
fi

if ! account="$(aws sts get-caller-identity --query Account --output text)"; then
  echo "The AWS CLI has no working credentials. Sign in first, e.g. with: aws login" >&2
  exit 1
fi

stack_status() {
  aws cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo NONE
}

stack_output() {
  aws cloudformation describe-stacks --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

status="$(stack_status "$stack")"

if [[ $code_only == true ]]; then
  if [[ $status == NONE || $status == ROLLBACK_COMPLETE ]]; then
    echo "Stack $stack is not deployed. Run a full deploy first: bash scripts/deploy.sh" >&2
    exit 1
  fi
else
  : "${DOMAIN_NAME:?Set DOMAIN_NAME in .env.production}"
  : "${HOSTED_ZONE_ID:?Set HOSTED_ZONE_ID in .env.production}"
  # Route 53 prints IDs as /hostedzone/Z...; CloudFormation wants the Z... part.
  HOSTED_ZONE_ID="${HOSTED_ZONE_ID#/hostedzone/}"

  # A first deploy that failed leaves a stack that CloudFormation can only
  # delete, and it holds no resources any more.
  if [[ $status == ROLLBACK_COMPLETE ]]; then
    echo "Deleting stack $stack, left behind by a first deploy that failed."
    aws cloudformation delete-stack --stack-name "$stack"
    aws cloudformation wait stack-delete-complete --stack-name "$stack"
    status=NONE
  fi

  # Check here rather than let the function fail to start: the service exits on
  # boot without keys, or with one that is too short.
  if [[ -n "${API_KEYS:-}" ]]; then
    IFS=, read -ra keys <<< "$API_KEYS"
    for key in "${keys[@]}"; do
      key="${key//[[:space:]]/}"
      if (( ${#key} < 16 )); then
        echo "Every key in API_KEYS must be at least 16 characters." >&2
        exit 1
      fi
    done
  elif [[ $status == NONE ]]; then
    echo "Set API_KEYS in .env.production for the first deploy; generate a key with: openssl rand -hex 32" >&2
    exit 1
  fi

  aws cloudformation deploy --stack-name "$stack-ecr" --template-file infra/ecr.yml \
    --tags "${tags[@]}" --no-fail-on-empty-changeset
fi

registry="$account.dkr.ecr.$AWS_REGION.amazonaws.com"
image="$registry/$repository:$(git rev-parse HEAD)"

# The function runs on x86_64 (infra/app.yml). Lambda rejects the image index
# that build attestations would wrap the image in.
docker build --platform linux/amd64 --provenance=false --sbom=false -t "$image" .

# Run the image the way Lambda will before pushing it: its entrypoint
# (ImageConfig in infra/app.yml), a read-only root with only /tmp writable, no
# /dev/shm, a user that is not in /etc/passwd, no capabilities, and the system
# calls Lambda refuses refused: capset(), which Chromium's zygote makes in every
# child, and registering as a subreaper (prctl 36), which tini -s makes. Then
# render a page served inside the container, so a browser that launches but
# crashes on its first page fails here too.
seccomp="$(mktemp)"
smoke=
trap 'rm -f "$seccomp"; if [[ -n $smoke ]]; then docker rm -f "$smoke" >/dev/null 2>&1 || true; fi' EXIT
cat > "$seccomp" <<'EOF'
{"defaultAction": "SCMP_ACT_ALLOW", "syscalls": [
  {"names": ["capset"], "action": "SCMP_ACT_ERRNO", "errnoRet": 1},
  {"names": ["prctl"], "action": "SCMP_ACT_ERRNO", "errnoRet": 1,
   "args": [{"index": 0, "value": 36, "op": "SCMP_CMP_EQ"}]}
]}
EOF
# no-new-privileges makes runc apply the profile last, after it has used capset
# itself to set up the container.
smoke="$(docker run -d --read-only --tmpfs /tmp --ipc none --user 993:990 --cap-drop ALL \
  --security-opt no-new-privileges --security-opt "seccomp=$seccomp" \
  -e API_KEYS=smoke-test-key-0123456789 -e HOME=/tmp -e ALLOW_PRIVATE_NETWORKS=true \
  --entrypoint node "$image" src/server.js)"
docker exec -d "$smoke" node -e \
  "require('node:http').createServer((req, res) => res.end('<h1>smoke test</h1>')).listen(8080, '127.0.0.1')"
probe="fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
for ((i = 1; ; i++)); do
  if docker exec "$smoke" node -e "$probe" 2>/dev/null; then
    break
  fi
  if (( i == 60 )) || [[ "$(docker inspect --format '{{.State.Running}}' "$smoke")" != true ]]; then
    echo "The image did not start; nothing was deployed. Its log:" >&2
    docker logs "$smoke" >&2 || true
    exit 1
  fi
  sleep 1
done
render="fetch('http://127.0.0.1:3000/render', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'smoke-test-key-0123456789' },
  body: JSON.stringify({ url: 'http://127.0.0.1:8080/' }),
}).then(async (r) => {
  if (r.headers.get('content-type') !== 'image/png') throw new Error(r.status + ' ' + (await r.text()));
})"
if ! docker exec "$smoke" node -e "$render"; then
  echo "The image starts but cannot render a page; nothing was deployed. Its log:" >&2
  docker logs "$smoke" >&2 || true
  exit 1
fi
docker rm -f "$smoke" >/dev/null
smoke=
echo "The image starts and renders a page."

aws ecr get-login-password | docker login --username AWS --password-stdin "$registry"
docker push "$image"

# What to roll back to if the new release does not come up.
previous="$(aws lambda get-function --function-name "$function_name" --query Code.ImageUri --output text 2>/dev/null || true)"

# Swaps the image and nothing else: the deployed template and every other
# parameter stay as they are. All push-to-deploy may do (infra/github-deploy.yml).
deploy_image() {
  local key keep=()
  for key in $(aws cloudformation describe-stacks --stack-name "$stack" --query 'Stacks[0].Parameters[].ParameterKey' --output text); do
    [[ $key == ImageUri ]] || keep+=("ParameterKey=$key,UsePreviousValue=true")
  done
  aws cloudformation update-stack --stack-name "$stack" --use-previous-template --capabilities CAPABILITY_IAM \
    --parameters "ParameterKey=ImageUri,ParameterValue=$1" "${keep[@]}" >/dev/null
  aws cloudformation wait stack-update-complete --stack-name "$stack"
}

if [[ $code_only == true ]]; then
  # Command substitution drops trailing newlines on both sides.
  if [[ "$(aws cloudformation get-template --stack-name "$stack" --query TemplateBody --output text)" != "$(cat infra/app.yml)" ]]; then
    echo "Warning: infra/app.yml differs from the deployed template. Push-to-deploy ships code only;" >&2
    echo "run bash scripts/deploy.sh from your machine to apply it." >&2
  fi
  if [[ $previous == "$image" ]]; then
    echo "$image is already deployed."
  else
    deploy_image "$image"
  fi
else
  params=(
    "ImageUri=$image"
    "DomainName=$DOMAIN_NAME"
    "HostedZoneId=$HOSTED_ZONE_ID"
    "MonthlyBudgetUsd=${MONTHLY_BUDGET_USD:-}"
    "AlertEmail=${ALERT_EMAIL:-}"
    "MaxInstances=${LAMBDA_MAX_INSTANCES:-}"
    "MemoryMb=${LAMBDA_MEMORY_MB:-}"
    "WebAclArn=${CLOUDFRONT_WEB_ACL_ARN:-}"
    "JobTimeoutMs=${JOB_TIMEOUT_MS:-}"
    "NavigationTimeoutMs=${NAVIGATION_TIMEOUT_MS:-}"
    "MaxImageHeight=${MAX_IMAGE_HEIGHT:-}"
    "MaxCaptureHeight=${MAX_CAPTURE_HEIGHT:-}"
    "BrowserRecycleAfter=${BROWSER_RECYCLE_AFTER:-}"
    "LogLevel=${LOG_LEVEL:-}"
  )
  # Left out, a parameter keeps its deployed value.
  if [[ -n "${API_KEYS:-}" ]]; then
    params+=("ApiKeys=$API_KEYS")
  fi
  if [[ $status == NONE ]]; then
    echo "First deploy: the certificate and the CloudFront distribution take 5 to 15 minutes."
  fi
  aws cloudformation deploy --stack-name "$stack" --template-file infra/app.yml \
    --capabilities CAPABILITY_IAM --tags "${tags[@]}" --no-fail-on-empty-changeset \
    --parameter-overrides "${params[@]}"
fi

# Lambda routes every request to the new image once the update completes, and
# the first one starts an instance, so this waits through a cold start.
function_url="$(stack_output FunctionUrl)"
healthy=false
for ((i = 0; i < 30; i++)); do
  if curl -fs -o /dev/null --max-time 30 "${function_url}healthz"; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ $healthy == false ]]; then
  echo "The new release does not answer ${function_url}healthz." >&2
  if [[ -n $previous && $previous != "$image" ]]; then
    echo "Rolling back to $previous." >&2
    deploy_image "$previous"
  fi
  echo "See its log with: aws logs tail /aws/lambda/$function_name --since 15m --region $AWS_REGION" >&2
  exit 1
fi

echo "Deployed $image"
echo "API: $(stack_output PublicUrl)  (CloudFront: https://$(stack_output DistributionDomain))"
