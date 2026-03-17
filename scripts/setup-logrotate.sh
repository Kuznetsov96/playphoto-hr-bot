#!/bin/bash

# =============================================================================
# Logrotate Setup Script for PlayPhoto Bot
# Configures automatic rotation for application logs.
# =============================================================================

LOG_DIR="/home/playphoto-mgr/playphoto_hr_bot/logs"
CONF_FILE="/etc/logrotate.d/playphoto_bot"

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (sudo)"
  exit 1
fi

mkdir -p "$LOG_DIR"
chown -R playphoto-mgr:playphoto-mgr "$LOG_DIR"

cat > "$CONF_FILE" << EOF
$LOG_DIR/*.log {
    daily
    missingok
    rotate 7
    compress
    delaycompress
    notifempty
    create 0640 playphoto-mgr playphoto-mgr
}
EOF

echo "Logrotate configured successfully at $CONF_FILE"
logrotate -d "$CONF_FILE" # Debug run to verify
