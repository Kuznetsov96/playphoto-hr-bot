#!/bin/bash

# =============================================================================
# Disk Space Monitor Script for PlayPhoto Bot
# Sends a Telegram alert if disk usage exceeds the threshold.
# =============================================================================

THRESHOLD=85
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

# Load environment variables
if [ -f "$ENV_FILE" ]; then
    BOT_TOKEN=$(grep '^BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'\'' ')
    ADMIN_IDS=$(grep '^ADMIN_IDS=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'\'' ')
    # Take the first ID if multiple are provided
    ADMIN_CHAT_ID=$(echo "$ADMIN_IDS" | cut -d, -f1)
else
    echo "Error: .env file not found at $ENV_FILE"
    exit 1
fi

if [ -z "$BOT_TOKEN" ] || [ -z "$ADMIN_CHAT_ID" ]; then
    echo "Error: BOT_TOKEN or ADMIN_IDS not found in .env"
    exit 1
fi

# Get current disk usage of root partition
DISK_USAGE=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')

if [ "$DISK_USAGE" -ge "$THRESHOLD" ]; then
    SERVER_NAME=$(hostname)
    MESSAGE="🚨 <b>CRITICAL: Low Disk Space!</b>%0A%0A🖥 Server: <code>${SERVER_NAME}</code>%0A💾 Usage: <b>${DISK_USAGE}%</b>%0A%0AAction required: Please clean up Docker images or logs to prevent bot failure."
    
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d chat_id="${ADMIN_CHAT_ID}" \
        -d text="${MESSAGE}" \
        -d parse_mode="HTML" > /dev/null
    
    echo "Alert sent! Disk usage is at ${DISK_USAGE}%"
else
    echo "Disk usage is normal: ${DISK_USAGE}%"
fi
