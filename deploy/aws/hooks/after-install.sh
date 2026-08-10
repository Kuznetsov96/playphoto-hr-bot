#!/usr/bin/env bash
set -euo pipefail

test -s /opt/playphoto-bot/release.env
test -s /opt/playphoto-bot/compose.aws.yaml
test -s /opt/playphoto-bot/compose.aws.live.yaml

chmod 0600 /opt/playphoto-bot/release.env
chmod 0750 /opt/playphoto-bot/scripts/aws/deploy-production-bot.sh \
  /opt/playphoto-bot/scripts/aws/set-production-mode.sh \
  /opt/playphoto-bot/hooks/*.sh

bash -n /opt/playphoto-bot/scripts/aws/deploy-production-bot.sh
bash -n /opt/playphoto-bot/scripts/aws/set-production-mode.sh
bash -n /opt/playphoto-bot/hooks/before-install.sh
bash -n /opt/playphoto-bot/hooks/start.sh
bash -n /opt/playphoto-bot/hooks/validate.sh

command -v aws >/dev/null
command -v docker >/dev/null
command -v jq >/dev/null
docker compose version >/dev/null
