#!/bin/bash
# =============================================================================
# Google Drive Upload Script (Docker JS Version)
# =============================================================================

set -euo pipefail

FILE_PATH="${1:-}"
if [ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ]; then
  echo "ERROR: File not found: $FILE_PATH"
  exit 1
fi

PROJECT_DIR="/home/playphoto-mgr/playphoto_hr_bot"
FILENAME=$(basename "$FILE_PATH")

# We must copy the file TO the container first, or use a volume. 
# Since backups are in the project folder, and it's already a volume, we use the internal path.
INTERNAL_PATH="/app/logs/backups/$FILENAME"

echo "[$(date)] 🚀 Uploading $FILENAME using Service Account (via Node.js in Docker)..."

docker compose exec -T bot node scripts/upload-to-gdrive.js "$INTERNAL_PATH"
