#!/usr/bin/env bash
set -euo pipefail

install -d -m 0750 /opt/playphoto-bot /opt/playphoto-bot/hooks /opt/playphoto-bot/scripts/aws

if [[ -f /opt/playphoto-bot/release.env ]]; then
  install -m 0600 /opt/playphoto-bot/release.env /opt/playphoto-bot/previous-release.env
fi
