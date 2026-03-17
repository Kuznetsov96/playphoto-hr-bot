#!/bin/bash
# =============================================================================
# PostgreSQL Backup Script
# Creates a compressed backup and optionally uploads to Google Drive
# Usage: ./scripts/backup-db.sh
# =============================================================================

set -euo pipefail

# Get the directory where the script is located and go up one level
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BACKUP_DIR="$PROJECT_DIR/backups"
RETENTION_DAYS=30
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M")
BACKUP_FILE="$BACKUP_DIR/backup_${TIMESTAMP}.sql.gz"

# Load env variables for DB credentials (optional)
if [ -f "$PROJECT_DIR/.env" ]; then
  # Use a subshell to avoid polluting current shell with 'set -a'
  # and only import if we actually need the variables
  if [ -z "${DATABASE_URL:-}" ]; then
    set -a
    source "$PROJECT_DIR/.env" || true
    set +a
  fi
fi

# Extract DB credentials from DATABASE_URL if separate vars are missing
if [ -z "${POSTGRES_USER:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
  # Extract user from postgresql://user:pass@host:port/db
  POSTGRES_USER=$(echo "$DATABASE_URL" | sed -n 's|.*//\([^:]*\):.*|\1|p')
fi
if [ -z "${POSTGRES_DB:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
  # Extract db name from the end of the URL
  POSTGRES_DB=$(echo "$DATABASE_URL" | sed -n 's|.*/\([^?]*\).*|\1|p')
fi

DB_USER="${POSTGRES_USER:-postgres}"
DB_NAME="${POSTGRES_DB:-playphoto_bot}"

mkdir -p "$BACKUP_DIR"

echo "[$(date)] Starting database backup for database: $DB_NAME..."

# Check if postgres container is running
IS_RUNNING=$(docker compose -f "$PROJECT_DIR/docker-compose.yml" ps -q postgres 2>/dev/null | xargs docker inspect -f '{{.State.Running}}' 2>/dev/null || echo "false")

DOCKER_CMD="exec -T"
if [ "$IS_RUNNING" != "true" ]; then
  echo "[$(date)] ⚠️ Postgres container is not running. Using 'run --rm' instead..."
  DOCKER_CMD="run --rm"
fi

# Create backup via docker compose and encrypt if passphrase is provided
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  BACKUP_FILE="$BACKUP_DIR/backup_${TIMESTAMP}.sql.gz.enc"
  docker compose -f "$PROJECT_DIR/docker-compose.yml" $DOCKER_CMD postgres \
    pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists --no-owner \
    | gzip | openssl enc -aes-256-cbc -salt -pbkdf2 -pass pass:"$BACKUP_PASSPHRASE" > "$BACKUP_FILE"
  echo "[$(date)] 🔒 Backup created and ENCRYPTED (AES-256)"
else
  docker compose -f "$PROJECT_DIR/docker-compose.yml" $DOCKER_CMD postgres \
    pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists --no-owner \
    | gzip > "$BACKUP_FILE"
  echo "[$(date)] ⚠️ WARNING: BACKUP_PASSPHRASE not set. Backup created UNENCRYPTED."
fi

# Verify backup is not empty
FILESIZE=$(stat -c%s "$BACKUP_FILE" 2>/dev/null || stat -f%z "$BACKUP_FILE" 2>/dev/null || echo "0")
if [ "$FILESIZE" -lt 100 ]; then
  echo "[$(date)] ERROR: Backup file is suspiciously small ($FILESIZE bytes). Aborting."
  rm -f "$BACKUP_FILE"
  exit 1
fi

echo "[$(date)] Backup file ready: $BACKUP_FILE ($FILESIZE bytes)"

# Upload to Google Drive if credentials available and not skipped
if [ "${SKIP_GDRIVE_UPLOAD:-false}" != "true" ] && [ -f "$PROJECT_DIR/scripts/upload-to-gdrive.sh" ]; then
  bash "$PROJECT_DIR/scripts/upload-to-gdrive.sh" "$BACKUP_FILE" 2>&1 || \
    echo "[$(date)] WARNING: Google Drive upload failed, backup is still saved locally"
else
  echo "[$(date)] Skipping Google Drive upload (SKIP_GDRIVE_UPLOAD=$SKIP_GDRIVE_UPLOAD)"
fi

# Remove old backups (keep last RETENTION_DAYS days)
find "$BACKUP_DIR" -type f -name "backup_*.sql.gz*" -mtime +$RETENTION_DAYS -delete 2>/dev/null || true
REMAINING=$(find "$BACKUP_DIR" -type f -name "backup_*.sql.gz*" | wc -l)
echo "[$(date)] Cleanup done. $REMAINING backups remaining."

# Output the backup file path (used by CI/CD)
echo "$BACKUP_FILE"
