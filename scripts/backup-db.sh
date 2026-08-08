#!/bin/bash
# =============================================================================
# PostgreSQL Universal Backup Script (v2.0)
# Supports local encryption (AES-256) and Google Drive via Service Account
# =============================================================================

set -euo pipefail

# Auto-detect directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="$PROJECT_DIR/logs/backups"
LOG_FILE="$PROJECT_DIR/logs/backup.log"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M")

mkdir -p "$BACKUP_DIR" "$PROJECT_DIR/logs"
cd "$PROJECT_DIR"

# Load runtime variables from an explicit file or the two supported deployment paths.
ENV_FILE="${BOT_ENV_FILE:-}"
if [ -z "$ENV_FILE" ]; then
    for candidate in "$PROJECT_DIR/.env" /root/playphoto-secrets/bot.env; do
        if [ -r "$candidate" ]; then
            ENV_FILE="$candidate"
            break
        fi
    done
fi
if [ -z "$ENV_FILE" ] || [ ! -r "$ENV_FILE" ]; then
    echo "[$(date)] ERROR: no readable bot runtime environment file was found." >&2
    exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
    echo "[$(date)] ERROR: BACKUP_PASSPHRASE is missing; refusing to create an unencrypted backup." >&2
    exit 1
fi

DB_USER="${POSTGRES_USER:-postgres}"
DB_NAME="${POSTGRES_DB:-playphoto_bot}"
KEY_FILE="$PROJECT_DIR/google-service-account.json"

echo "[$(date)] 🚀 Starting database backup for: $DB_NAME"

# 1. Detect Docker Command
DOCKER_COMPOSE_CMD="docker compose"
if ! docker compose version &>/dev/null; then
    DOCKER_COMPOSE_CMD="docker-compose"
fi

# 2. Perform Dump (with encryption)
BACKUP_FILE="$BACKUP_DIR/backup_${TIMESTAMP}.sql.gz.enc"
PARTIAL_FILE="${BACKUP_FILE}.partial"
trap 'rm -f "$PARTIAL_FILE"' EXIT
umask 077

$DOCKER_COMPOSE_CMD exec -T postgres /bin/bash -c "pg_dump -U $DB_USER -d $DB_NAME --clean --if-exists --no-owner" \
| gzip | openssl enc -aes-256-cbc -salt -pbkdf2 -pass env:BACKUP_PASSPHRASE > "$PARTIAL_FILE"

openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -in "$PARTIAL_FILE" | gzip -t
mv "$PARTIAL_FILE" "$BACKUP_FILE"
chmod 0600 "$BACKUP_FILE"
echo "[$(date)] 🔒 Encrypted backup created and stream-verified (AES-256/PBKDF2)"

# 3. Verify
FILESIZE=$(stat -c%s "$BACKUP_FILE" 2>/dev/null || stat -f%z "$BACKUP_FILE" 2>/dev/null || echo "0")
if [ "$FILESIZE" -lt 100 ]; then
    echo "[$(date)] ❌ ERROR: Backup failed (file is empty)"
    exit 1
fi

# 4. Upload to Google Drive (if key exists)
if [ -s "$KEY_FILE" ] && [ "${SKIP_GDRIVE_UPLOAD:-false}" != "true" ]; then
    echo "[$(date)] ☁️ Uploading to Google Drive..."
    bash "$SCRIPT_DIR/upload-to-gdrive.sh" "$BACKUP_FILE" || echo "[$(date)] ⚠️ Upload failed, but local copy is safe."
else
    echo "[$(date)] ⏩ Skipping Google Drive upload (No key or SKIP_GDRIVE_UPLOAD=true)"
fi

# 5. Local Cleanup (keep 30 days)
find "$BACKUP_DIR" -type f -name "backup_*.sql.gz*" -mtime +30 -delete
echo "[$(date)] ✅ Backup process completed. Local file: $BACKUP_FILE"
