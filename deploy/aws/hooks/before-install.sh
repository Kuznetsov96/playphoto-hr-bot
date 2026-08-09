#!/usr/bin/env bash
set -euo pipefail

install -d -m 0750 /opt/playphoto-bot /opt/playphoto-bot/hooks /opt/playphoto-bot/scripts/aws

deploy_directory="/opt/playphoto-bot"
rollback_directory="$deploy_directory/.rollback"

# Capture the last known-good runtime before CodeDeploy overwrites the revision files. The
# production container may be live even when an older release.env still says "standby", so the
# actual container command is authoritative for rollback mode.
if [[ -s "$deploy_directory/release.env" && -s "$deploy_directory/compose.aws.yaml" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$deploy_directory/release.env"
  set +a

  : "${BOT_IMAGE:?BOT_IMAGE is required in the installed release.env}"
  [[ "$BOT_IMAGE" == *@sha256:* ]] || {
    echo "Installed BOT_IMAGE is not pinned to an immutable digest." >&2
    exit 1
  }

  container_id="$(docker compose \
    --env-file "$deploy_directory/.env" \
    -f "$deploy_directory/compose.aws.yaml" \
    ps --quiet bot)"
  [[ -n "$container_id" ]] || {
    echo "Cannot capture rollback state: the current bot container is missing." >&2
    exit 1
  }

  command="$(docker inspect --format '{{json .Config.Cmd}}' "$container_id")"
  case "$command" in
    *start:live*) rollback_mode="live" ;;
    *start:standby*) rollback_mode="standby" ;;
    *)
      echo "Cannot capture rollback state: unknown bot command $command." >&2
      exit 1
      ;;
  esac

  expected_image_id="$(docker image inspect --format '{{.Id}}' "$BOT_IMAGE")"
  running_image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
  [[ "$expected_image_id" == "$running_image_id" ]] || {
    echo "Installed release image does not match the running bot container." >&2
    exit 1
  }

  rollback_staging="$(mktemp -d "$deploy_directory/.rollback-staging.XXXXXX")"
  chmod 0700 "$rollback_staging"
  cleanup_staging() {
    rm -rf "$rollback_staging"
  }
  trap cleanup_staging EXIT

  install -m 0600 "$deploy_directory/release.env" "$rollback_staging/installed-release.env"
  install -m 0600 "$deploy_directory/.env" "$rollback_staging/.env"
  install -m 0600 \
    "$deploy_directory/google-service-account.json" \
    "$rollback_staging/google-service-account.json"
  install -m 0644 "$deploy_directory/compose.aws.yaml" "$rollback_staging/compose.aws.yaml"
  install -m 0644 \
    "$deploy_directory/compose.aws.live.yaml" \
    "$rollback_staging/compose.aws.live.yaml"
  {
    printf 'BOT_IMAGE=%q\n' "$BOT_IMAGE"
    printf 'BOT_RUNTIME_MODE=%q\n' "$rollback_mode"
  } >"$rollback_staging/runtime.env"
  chmod 0600 "$rollback_staging/runtime.env"

  rm -rf "$rollback_directory"
  mv "$rollback_staging" "$rollback_directory"
  trap - EXIT

  install -m 0600 "$deploy_directory/release.env" "$deploy_directory/previous-release.env"
  echo "Captured immutable $rollback_mode rollback baseline."
fi
