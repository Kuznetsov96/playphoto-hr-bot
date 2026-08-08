#!/usr/bin/env bash
set -euo pipefail

: "${BOT_IMAGE:?BOT_IMAGE is required}"
: "${RUNTIME_SECRET_ID:?RUNTIME_SECRET_ID is required}"

AWS_REGION="${AWS_REGION:-eu-north-1}"
BOT_RUNTIME_MODE="${BOT_RUNTIME_MODE:-standby}"
DEPLOY_DIRECTORY="${DEPLOY_DIRECTORY:-/opt/playphoto-bot}"

if [[ "$BOT_RUNTIME_MODE" != "standby" ]]; then
  echo "This revision is intentionally standby-only; live Telegram polling is blocked." >&2
  exit 1
fi
if [[ "$BOT_IMAGE" != *@sha256:* ]]; then
  echo "BOT_IMAGE must be pinned to an immutable sha256 digest." >&2
  exit 1
fi

exec 9>"$DEPLOY_DIRECTORY/.deploy.lock"
if ! flock -n 9; then
  echo "Another production bot deployment is already running." >&2
  exit 1
fi

umask 077
runtime_json_file="$(mktemp "$DEPLOY_DIRECTORY/.runtime.XXXXXX")"
environment_file="$(mktemp "$DEPLOY_DIRECTORY/.env.XXXXXX")"
google_file="$(mktemp "$DEPLOY_DIRECTORY/.google.XXXXXX")"
docker_config_directory="$(mktemp -d "$DEPLOY_DIRECTORY/.docker.XXXXXX")"
registry=""
export DOCKER_CONFIG="$docker_config_directory"

cleanup() {
  rm -f "$runtime_json_file" "$environment_file" "$google_file"
  if [[ -n "$registry" ]]; then
    docker logout "$registry" >/dev/null 2>&1 || true
  fi
  rm -f "$docker_config_directory/config.json"
  rmdir "$docker_config_directory" 2>/dev/null || true
  unset DOCKER_CONFIG
}
trap cleanup EXIT

aws secretsmanager get-secret-value \
  --secret-id "$RUNTIME_SECRET_ID" \
  --region "$AWS_REGION" \
  --query SecretString \
  --output text >"$runtime_json_file"

jq -e '
  (.dockerEnv | type == "string" and length > 0) and
  (.googleServiceAccountJson | type == "string" and length > 0) and
  (.databaseUrl | type == "string" and startswith("postgresql://")) and
  (.businessApiUrl | type == "string" and startswith("https://")) and
  (.businessApiToken | type == "string" and length >= 32)
' "$runtime_json_file" >/dev/null

jq -r '.dockerEnv' "$runtime_json_file" >"$environment_file"
jq -r '.googleServiceAccountJson' "$runtime_json_file" >"$google_file"
jq -e . "$google_file" >/dev/null

set_env() {
  local key="$1"
  local value="$2"
  local filtered
  filtered="$(mktemp "$DEPLOY_DIRECTORY/.env-filtered.XXXXXX")"
  awk -v prefix="${key}=" 'index($0, prefix) != 1' "$environment_file" >"$filtered"
  printf '%s=%s\n' "$key" "$value" >>"$filtered"
  mv "$filtered" "$environment_file"
}

set_env NODE_ENV production
set_env BUSINESS_DATA_SOURCE aws
set_env AWS_BUSINESS_API_URL "$(jq -r '.businessApiUrl' "$runtime_json_file")"
set_env AWS_BUSINESS_API_TOKEN "$(jq -r '.businessApiToken' "$runtime_json_file")"
set_env DATABASE_URL "$(jq -r '.databaseUrl' "$runtime_json_file")"
set_env REDIS_URL "$(jq -r '.redisUrl // "redis://redis:6379"' "$runtime_json_file")"
set_env AWS_BUSINESS_MIN_EMPLOYEES "$(jq -r '.minimumEmployees // 50' "$runtime_json_file")"
set_env AWS_BUSINESS_MIN_LOCATIONS "$(jq -r '.minimumLocations // 19' "$runtime_json_file")"

chmod 0600 "$environment_file" "$google_file"
mv "$environment_file" "$DEPLOY_DIRECTORY/.env"
mv "$google_file" "$DEPLOY_DIRECTORY/google-service-account.json"

registry="${BOT_IMAGE%%/*}"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$registry" >/dev/null

compose=(docker compose --env-file "$DEPLOY_DIRECTORY/.env" -f "$DEPLOY_DIRECTORY/compose.aws.yaml")
"${compose[@]}" config --quiet
"${compose[@]}" pull
"${compose[@]}" up -d --remove-orphans
"${compose[@]}" ps
