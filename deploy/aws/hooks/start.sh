#!/usr/bin/env bash
set -euo pipefail

cd /opt/playphoto-bot
set -a
# shellcheck disable=SC1091
source /opt/playphoto-bot/release.env
set +a

export AWS_REGION BOT_IMAGE BOT_RUNTIME_MODE RUNTIME_SECRET_ID
/opt/playphoto-bot/scripts/aws/deploy-production-bot.sh
