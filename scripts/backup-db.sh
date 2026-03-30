#!/bin/bash
# =============================================================================
# PostgreSQL Universal Backup Script (v2.0)
# Supports local encryption (AES-256) and Google Drive via Service Account
# =============================================================================

set -euo pipefail

# Auto-detect directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="$PROJECT_DIR/backups"
LOG_FILE="$PROJECT_DIR/logs/backup.log"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M")

mkdir -p "$BACKUP_DIR" "$PROJECT_DIR/logs"

# Load env variables
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a; source "$PROJECT_DIR/.env"; set +a
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

if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    $DOCKER_COMPOSE_CMD exec -T postgres /bin/bash -c "pg_dump -U $DB_USER -d $DB_NAME --clean --if-exists --no-owner" \
    | gzip | openssl enc -aes-256-cbc -salt -pbkdf2 -pass pass:"$BACKUP_PASSPHRASE" > "$BACKUP_FILE"
    echo "[$(date)] 🔒 Backup created and ENCRYPTED (AES-256)"
else
    BACKUP_FILE="$BACKUP_DIR/backup_${TIMESTAMP}.sql.gz"
    $DOCKER_COMPOSE_CMD exec -T postgres /bin/bash -c "pg_dump -U $DB_USER -d $DB_NAME --clean --if-exists --no-owner" \
    | gzip > "$BACKUP_FILE"
    echo "[$(date)] ⚠️ WARNING: BACKUP_PASSPHRASE not set. Backup created UNENCRYPTED."
fi

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
