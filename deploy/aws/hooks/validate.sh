#!/usr/bin/env bash
set -euo pipefail

cd /opt/playphoto-bot
set -a
# shellcheck disable=SC1091
source /opt/playphoto-bot/release.env
set +a

compose=(docker compose --env-file /opt/playphoto-bot/.env -f /opt/playphoto-bot/compose.aws.yaml)

for attempt in {1..40}; do
  container_id="$("${compose[@]}" ps --quiet bot)"
  if [[ -n "$container_id" ]]; then
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
    if [[ "$health" == "healthy" ]]; then
      mode="$(docker inspect --format '{{json .Config.Cmd}}' "$container_id")"
      [[ "$mode" == *"start:standby"* ]] || {
        echo "Safety check failed: deployed bot is not in standby mode." >&2
        exit 1
      }
      "${compose[@]}" ps
      echo "Production bot standby is healthy; Telegram polling remains disabled."
      exit 0
    fi
  fi
  echo "Waiting for bot standby health ($attempt/40)."
  sleep 5
done

"${compose[@]}" ps >&2
"${compose[@]}" logs --tail=100 bot >&2
exit 1
