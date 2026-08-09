#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
DEPLOY_DIRECTORY="${DEPLOY_DIRECTORY:-/opt/playphoto-bot}"
CONFIRMATION="${AWS_LIVE_CUTOVER_CONFIRMATION:-}"

if [[ "$MODE" != "live" && "$MODE" != "standby" ]]; then
  echo "Usage: $0 live|standby" >&2
  exit 2
fi

cd "$DEPLOY_DIRECTORY"
set -a
# shellcheck disable=SC1091
source "$DEPLOY_DIRECTORY/release.env"
set +a

: "${BOT_IMAGE:?BOT_IMAGE is required in release.env}"
if [[ "$BOT_IMAGE" != *@sha256:* ]]; then
  echo "BOT_IMAGE must be pinned to an immutable sha256 digest." >&2
  exit 1
fi

exec 9>"$DEPLOY_DIRECTORY/.deploy.lock"
if ! flock -n 9; then
  echo "Another production bot deployment or mode change is running." >&2
  exit 1
fi

base=(docker compose --env-file "$DEPLOY_DIRECTORY/.env" -f "$DEPLOY_DIRECTORY/compose.aws.yaml")
live=("${base[@]}" -f "$DEPLOY_DIRECTORY/compose.aws.live.yaml")

wait_for_stable_container() {
  local expected_command="$1"
  local compose_name="$2"
  shift 2
  local -a selected=("$@")
  local container_id=""
  local initial_restarts=""

  for attempt in {1..30}; do
    container_id="$("${selected[@]}" ps --quiet bot)"
    if [[ -n "$container_id" ]]; then
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
      command="$(docker inspect --format '{{json .Config.Cmd}}' "$container_id")"
      if [[ "$health" == "healthy" && "$command" == *"$expected_command"* ]]; then
        initial_restarts="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
        break
      fi
    fi
    echo "Waiting for $compose_name health ($attempt/30)."
    sleep 5
  done

  if [[ -z "$initial_restarts" ]]; then
    return 1
  fi

  # A transient green health check is insufficient for Telegram polling.
  # Require the same container to remain healthy without restarting for 60 seconds.
  for attempt in {1..12}; do
    sleep 5
    current_id="$("${selected[@]}" ps --quiet bot)"
    [[ "$current_id" == "$container_id" ]] || return 1
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
    restarts="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
    [[ "$health" == "healthy" && "$restarts" == "$initial_restarts" ]] || return 1
  done
}

if [[ "$MODE" == "standby" ]]; then
  "${base[@]}" up -d --no-deps --force-recreate bot
  wait_for_stable_container "start:standby" "standby" "${base[@]}"
  "${base[@]}" ps
  echo "AWS bot is healthy in standby; Telegram polling is disabled."
  exit 0
fi

if [[ "$CONFIRMATION" != "HETZNER_STOPPED_START_AWS_LIVE" ]]; then
  echo "Live activation refused: first stop and verify the Hetzner bot, then set" >&2
  echo "AWS_LIVE_CUTOVER_CONFIRMATION=HETZNER_STOPPED_START_AWS_LIVE" >&2
  exit 1
fi

rollback() {
  echo "Live activation failed; returning AWS bot to standby." >&2
  "${base[@]}" up -d --no-deps --force-recreate bot || true
}
trap rollback ERR

"${live[@]}" config --quiet
"${live[@]}" up -d --no-deps --force-recreate bot
wait_for_stable_container "start:live" "live bot" "${live[@]}"
trap - ERR
"${live[@]}" ps
echo "AWS bot is healthy in live mode; Telegram polling is enabled."
