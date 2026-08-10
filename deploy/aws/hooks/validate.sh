#!/usr/bin/env bash
set -euo pipefail

cd /opt/playphoto-bot
set -a
# shellcheck disable=SC1091
source /opt/playphoto-bot/release.env
set +a

rollback_on_error() {
  exit_code="$?"
  trap - ERR
  echo "Deployment validation failed; restoring the captured runtime." >&2
  /opt/playphoto-bot/scripts/aws/deploy-production-bot.sh rollback || {
    echo "Validation rollback failed." >&2
  }
  exit "$exit_code"
}
trap rollback_on_error ERR

: "${BOT_RUNTIME_MODE:?BOT_RUNTIME_MODE is required}"
: "${AWS_SCHEDULE_SHADOW_READ_ENABLED:?AWS_SCHEDULE_SHADOW_READ_ENABLED is required}"
: "${AWS_SCHEDULE_CANONICAL_READ_ENABLED:?AWS_SCHEDULE_CANONICAL_READ_ENABLED is required}"
: "${AWS_SCHEDULE_NOTIFICATIONS_ENABLED:?AWS_SCHEDULE_NOTIFICATIONS_ENABLED is required}"
: "${AWS_REPLACEMENTS_SHADOW_ENABLED:?AWS_REPLACEMENTS_SHADOW_ENABLED is required}"
: "${AWS_REPLACEMENTS_CANONICAL_ENABLED:?AWS_REPLACEMENTS_CANONICAL_ENABLED is required}"
: "${AWS_REMINDERS_CANONICAL_READ_ENABLED:?AWS_REMINDERS_CANONICAL_READ_ENABLED is required}"
: "${AWS_PREFERENCES_CANONICAL_WRITE_ENABLED:?AWS_PREFERENCES_CANONICAL_WRITE_ENABLED is required}"
[[ "$BOT_RUNTIME_MODE" == "live" || "$BOT_RUNTIME_MODE" == "standby" ]]
[[ "$AWS_SCHEDULE_SHADOW_READ_ENABLED" == "true" || "$AWS_SCHEDULE_SHADOW_READ_ENABLED" == "false" ]]
[[ "$AWS_SCHEDULE_CANONICAL_READ_ENABLED" == "true" || "$AWS_SCHEDULE_CANONICAL_READ_ENABLED" == "false" ]]
[[ "$AWS_SCHEDULE_NOTIFICATIONS_ENABLED" == "true" || "$AWS_SCHEDULE_NOTIFICATIONS_ENABLED" == "false" ]]
[[ "$AWS_REPLACEMENTS_SHADOW_ENABLED" == "true" || "$AWS_REPLACEMENTS_SHADOW_ENABLED" == "false" ]]
[[ "$AWS_REPLACEMENTS_CANONICAL_ENABLED" == "true" || "$AWS_REPLACEMENTS_CANONICAL_ENABLED" == "false" ]]
[[ "$AWS_REMINDERS_CANONICAL_READ_ENABLED" == "true" || "$AWS_REMINDERS_CANONICAL_READ_ENABLED" == "false" ]]
[[ "$AWS_PREFERENCES_CANONICAL_WRITE_ENABLED" == "true" || "$AWS_PREFERENCES_CANONICAL_WRITE_ENABLED" == "false" ]]

base=(docker compose --env-file /opt/playphoto-bot/.env -f /opt/playphoto-bot/compose.aws.yaml)
selected=("${base[@]}")
expected_command="start:standby"
if [[ "$BOT_RUNTIME_MODE" == "live" ]]; then
  selected+=( -f /opt/playphoto-bot/compose.aws.live.yaml )
  expected_command="start:live"
fi

container_id=""
initial_restarts=""

for attempt in {1..40}; do
  container_id="$("${selected[@]}" ps --quiet bot)"
  if [[ -n "$container_id" ]]; then
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
    command="$(docker inspect --format '{{json .Config.Cmd}}' "$container_id")"
    if [[ "$health" == "healthy" && "$command" == *"$expected_command"* ]]; then
      initial_restarts="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
      break
    fi
  fi
  echo "Waiting for bot $BOT_RUNTIME_MODE health ($attempt/40)."
  sleep 5
done

[[ -n "$initial_restarts" ]] || {
  "${selected[@]}" ps >&2
  "${selected[@]}" logs --tail=100 bot >&2
  false
}

# Require one minute of stable health and an unchanged container before accepting polling.
for attempt in {1..12}; do
  sleep 5
  current_id="$("${selected[@]}" ps --quiet bot)"
  [[ "$current_id" == "$container_id" ]]
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
  restarts="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
  [[ "$health" == "healthy" && "$restarts" == "$initial_restarts" ]]
done

actual_shadow_flag="$(docker inspect \
  --format '{{range .Config.Env}}{{println .}}{{end}}' \
  "$container_id" | awk -F= '$1 == "AWS_SCHEDULE_SHADOW_READ_ENABLED" { print $2 }')"
[[ "${actual_shadow_flag:-false}" == "$AWS_SCHEDULE_SHADOW_READ_ENABLED" ]]

actual_canonical_flag="$(docker inspect \
  --format '{{range .Config.Env}}{{println .}}{{end}}' \
  "$container_id" | awk -F= '$1 == "AWS_SCHEDULE_CANONICAL_READ_ENABLED" { print $2 }')"
[[ "${actual_canonical_flag:-false}" == "$AWS_SCHEDULE_CANONICAL_READ_ENABLED" ]]

trap - ERR
"${selected[@]}" ps
echo "Production bot $BOT_RUNTIME_MODE is stable; schedule shadow=$AWS_SCHEDULE_SHADOW_READ_ENABLED canonical=$AWS_SCHEDULE_CANONICAL_READ_ENABLED."
