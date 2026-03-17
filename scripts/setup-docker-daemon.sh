#!/bin/bash

# =============================================================================
# Global Docker Log Protection Setup
# Configures Docker Daemon to limit log sizes for ALL containers.
# =============================================================================

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (sudo)"
  exit 1
fi

DAEMON_JSON="/etc/docker/daemon.json"

echo "=== Configuring Docker Log Rotation ==="

if [ -f "$DAEMON_JSON" ]; then
    # Backup existing config
    cp "$DAEMON_JSON" "${DAEMON_JSON}.bak"
    echo "Backup of existing daemon.json created."
fi

# Create or overwrite daemon.json with safe log limits
cat > "$DAEMON_JSON" << EOF
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "3"
  }
}
EOF

echo "New configuration applied to $DAEMON_JSON"
echo "Restarting Docker service..."
systemctl restart docker

echo "✅ Global Docker log limits are active (max 150MB per container)."
