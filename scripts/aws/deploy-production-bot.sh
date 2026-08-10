#!/usr/bin/env bash
set -euo pipefail

: "${BOT_IMAGE:?BOT_IMAGE is required}"
: "${RUNTIME_SECRET_ID:?RUNTIME_SECRET_ID is required}"

AWS_REGION="${AWS_REGION:-eu-north-1}"
BOT_RUNTIME_MODE="${BOT_RUNTIME_MODE:-live}"
AWS_SCHEDULE_SHADOW_READ_ENABLED="${AWS_SCHEDULE_SHADOW_READ_ENABLED:-false}"
AWS_SCHEDULE_CANONICAL_READ_ENABLED="${AWS_SCHEDULE_CANONICAL_READ_ENABLED:-false}"
AWS_SCHEDULE_NOTIFICATIONS_ENABLED="${AWS_SCHEDULE_NOTIFICATIONS_ENABLED:-false}"
AWS_REPLACEMENTS_SHADOW_ENABLED="${AWS_REPLACEMENTS_SHADOW_ENABLED:-false}"
AWS_REPLACEMENTS_CANONICAL_ENABLED="${AWS_REPLACEMENTS_CANONICAL_ENABLED:-false}"
AWS_REMINDERS_CANONICAL_READ_ENABLED="${AWS_REMINDERS_CANONICAL_READ_ENABLED:-false}"
AWS_PREFERENCES_CANONICAL_WRITE_ENABLED="${AWS_PREFERENCES_CANONICAL_WRITE_ENABLED:-false}"
DEPLOY_DIRECTORY="${DEPLOY_DIRECTORY:-/opt/playphoto-bot}"
ROLLBACK_DIRECTORY="$DEPLOY_DIRECTORY/.rollback"
ACTION="${1:-deploy}"

if [[ "$BOT_RUNTIME_MODE" != "live" && "$BOT_RUNTIME_MODE" != "standby" ]]; then
  echo "BOT_RUNTIME_MODE must be live or standby." >&2
  exit 1
fi
if [[ "$BOT_IMAGE" != *@sha256:* ]]; then
  echo "BOT_IMAGE must be pinned to an immutable sha256 digest." >&2
  exit 1
fi
if [[ "$AWS_SCHEDULE_SHADOW_READ_ENABLED" != "true" && "$AWS_SCHEDULE_SHADOW_READ_ENABLED" != "false" ]]; then
  echo "AWS_SCHEDULE_SHADOW_READ_ENABLED must be true or false." >&2
  exit 1
fi
if [[ "$AWS_SCHEDULE_NOTIFICATIONS_ENABLED" != "true" && "$AWS_SCHEDULE_NOTIFICATIONS_ENABLED" != "false" ]]; then
  echo "AWS_SCHEDULE_NOTIFICATIONS_ENABLED must be true or false." >&2
  exit 1
fi
if [[ "$AWS_SCHEDULE_CANONICAL_READ_ENABLED" != "true" && "$AWS_SCHEDULE_CANONICAL_READ_ENABLED" != "false" ]]; then
  echo "AWS_SCHEDULE_CANONICAL_READ_ENABLED must be true or false." >&2
  exit 1
fi
if [[ "$AWS_REPLACEMENTS_SHADOW_ENABLED" != "true" && "$AWS_REPLACEMENTS_SHADOW_ENABLED" != "false" ]]; then
  echo "AWS_REPLACEMENTS_SHADOW_ENABLED must be true or false." >&2
  exit 1
fi
if [[ "$AWS_REPLACEMENTS_CANONICAL_ENABLED" != "true" && "$AWS_REPLACEMENTS_CANONICAL_ENABLED" != "false" ]]; then
  echo "AWS_REPLACEMENTS_CANONICAL_ENABLED must be true or false." >&2
  exit 1
fi
if [[ "$AWS_REMINDERS_CANONICAL_READ_ENABLED" != "true" && "$AWS_REMINDERS_CANONICAL_READ_ENABLED" != "false" ]]; then
  echo "AWS_REMINDERS_CANONICAL_READ_ENABLED must be true or false." >&2
  exit 1
fi
if [[ "$AWS_PREFERENCES_CANONICAL_WRITE_ENABLED" != "true" && "$AWS_PREFERENCES_CANONICAL_WRITE_ENABLED" != "false" ]]; then
  echo "AWS_PREFERENCES_CANONICAL_WRITE_ENABLED must be true or false." >&2
  exit 1
fi
if [[ "$ACTION" != "deploy" && "$ACTION" != "rollback" ]]; then
  echo "Usage: $0 [deploy|rollback]" >&2
  exit 2
fi

exec 9>"$DEPLOY_DIRECTORY/.deploy.lock"
if ! flock -n 9; then
  echo "Another production bot deployment is already running." >&2
  exit 1
fi

wait_for_stable_container() {
  local expected_command="$1"
  shift
  local -a selected=("$@")
  local container_id=""
  local initial_restarts=""

  for attempt in {1..40}; do
    container_id="$("${selected[@]}" ps --quiet bot)" || return 1
    if [[ -n "$container_id" ]]; then
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")" || return 1
      command="$(docker inspect --format '{{json .Config.Cmd}}' "$container_id")" || return 1
      if [[ "$health" == "healthy" && "$command" == *"$expected_command"* ]]; then
        initial_restarts="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
        break
      fi
    fi
    echo "Waiting for $expected_command health ($attempt/40)."
    sleep 5
  done

  [[ -n "$initial_restarts" ]] || return 1

  # Telegram polling must remain stable rather than only passing a transient health probe.
  for attempt in {1..12}; do
    sleep 5
    current_id="$("${selected[@]}" ps --quiet bot)" || return 1
    [[ "$current_id" == "$container_id" ]] || return 1
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")" || return 1
    restarts="$(docker inspect --format '{{.RestartCount}}' "$container_id")" || return 1
    [[ "$health" == "healthy" && "$restarts" == "$initial_restarts" ]] || return 1
  done
}

restore_rollback_runtime() {
  [[ -s "$ROLLBACK_DIRECTORY/runtime.env" ]] || {
    echo "Rollback baseline is missing." >&2
    return 1
  }
  set -a
  # shellcheck disable=SC1091
  source "$ROLLBACK_DIRECTORY/runtime.env" || return 1
  set +a

  : "${BOT_IMAGE:?Rollback BOT_IMAGE is required}"
  : "${BOT_RUNTIME_MODE:?Rollback BOT_RUNTIME_MODE is required}"
  [[ "$BOT_IMAGE" == *@sha256:* ]] || return 1
  [[ "$BOT_RUNTIME_MODE" == "live" || "$BOT_RUNTIME_MODE" == "standby" ]] || return 1

  install -m 0600 "$ROLLBACK_DIRECTORY/.env" "$DEPLOY_DIRECTORY/.env" || return 1
  install -m 0600 \
    "$ROLLBACK_DIRECTORY/google-service-account.json" \
    "$DEPLOY_DIRECTORY/google-service-account.json" || return 1
  install -m 0644 "$ROLLBACK_DIRECTORY/compose.aws.yaml" "$DEPLOY_DIRECTORY/compose.aws.yaml" || return 1
  install -m 0644 \
    "$ROLLBACK_DIRECTORY/compose.aws.live.yaml" \
    "$DEPLOY_DIRECTORY/compose.aws.live.yaml" || return 1

  export BOT_IMAGE
  base=(docker compose --env-file "$DEPLOY_DIRECTORY/.env" -f "$DEPLOY_DIRECTORY/compose.aws.yaml")
  selected=("${base[@]}")
  expected_command="start:standby"
  if [[ "$BOT_RUNTIME_MODE" == "live" ]]; then
    selected+=( -f "$DEPLOY_DIRECTORY/compose.aws.live.yaml" )
    expected_command="start:live"
  fi

  "${selected[@]}" config --quiet || return 1
  "${selected[@]}" up -d --no-deps --force-recreate bot || return 1
  wait_for_stable_container "$expected_command" "${selected[@]}" || return 1
  install -m 0600 \
    "$ROLLBACK_DIRECTORY/installed-release.env" \
    "$DEPLOY_DIRECTORY/release.env" || return 1
  "${selected[@]}" ps || return 1
  echo "Restored the immutable $BOT_RUNTIME_MODE rollback baseline."
}

if [[ "$ACTION" == "rollback" ]]; then
  restore_rollback_runtime
  exit 0
fi

# A normal live release may replace only an already-live poller. Initial cutover remains an
# explicit operation in set-production-mode.sh, which verifies the legacy bot is stopped.
if [[ "$BOT_RUNTIME_MODE" == "live" ]]; then
  current_container_id="$(docker compose \
    --env-file "$DEPLOY_DIRECTORY/.env" \
    -f "$DEPLOY_DIRECTORY/compose.aws.yaml" \
    ps --quiet bot)"
  current_command="$(docker inspect --format '{{json .Config.Cmd}}' "$current_container_id")"
  [[ "$current_command" == *"start:live"* ]] || {
    echo "Live deployment refused: the existing AWS bot is not already live." >&2
    exit 1
  }
fi

[[ -s "$ROLLBACK_DIRECTORY/runtime.env" ]] || {
  echo "Deployment refused: BeforeInstall did not capture a rollback baseline." >&2
  exit 1
}

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

rollback_on_error() {
  exit_code="$?"
  trap - ERR
  echo "Bot deployment failed; restoring the captured runtime." >&2
  restore_rollback_runtime || echo "Automatic local rollback failed." >&2
  exit "$exit_code"
}
trap rollback_on_error ERR

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
set_env AWS_SCHEDULE_SHADOW_READ_ENABLED "$AWS_SCHEDULE_SHADOW_READ_ENABLED"
set_env AWS_SCHEDULE_CANONICAL_READ_ENABLED "$AWS_SCHEDULE_CANONICAL_READ_ENABLED"
set_env AWS_SCHEDULE_NOTIFICATIONS_ENABLED "$AWS_SCHEDULE_NOTIFICATIONS_ENABLED"
set_env AWS_REPLACEMENTS_SHADOW_ENABLED "$AWS_REPLACEMENTS_SHADOW_ENABLED"
set_env AWS_REPLACEMENTS_CANONICAL_ENABLED "$AWS_REPLACEMENTS_CANONICAL_ENABLED"
set_env AWS_REMINDERS_CANONICAL_READ_ENABLED "$AWS_REMINDERS_CANONICAL_READ_ENABLED"
set_env AWS_PREFERENCES_CANONICAL_WRITE_ENABLED "$AWS_PREFERENCES_CANONICAL_WRITE_ENABLED"

chmod 0600 "$environment_file" "$google_file"
mv "$environment_file" "$DEPLOY_DIRECTORY/.env"
mv "$google_file" "$DEPLOY_DIRECTORY/google-service-account.json"

registry="${BOT_IMAGE%%/*}"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$registry" >/dev/null

base=(docker compose --env-file "$DEPLOY_DIRECTORY/.env" -f "$DEPLOY_DIRECTORY/compose.aws.yaml")
selected=("${base[@]}")
expected_command="start:standby"
if [[ "$BOT_RUNTIME_MODE" == "live" ]]; then
  selected+=( -f "$DEPLOY_DIRECTORY/compose.aws.live.yaml" )
  expected_command="start:live"
fi

"${selected[@]}" config --quiet
"${selected[@]}" pull
"${selected[@]}" up -d --remove-orphans
wait_for_stable_container "$expected_command" "${selected[@]}"
trap - ERR
"${selected[@]}" ps
echo "Production bot is healthy in $BOT_RUNTIME_MODE mode."
