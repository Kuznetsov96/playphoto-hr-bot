#!/bin/bash
# =============================================================================
# PostgreSQL Restore Script
# Restores database from a compressed backup file
# Usage: ./scripts/restore-db.sh <path-to-backup.sql.gz>
#   or:  ./scripts/restore-db.sh latest
# =============================================================================

set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/root/playphoto_hr_bot}"
BACKUP_DIR="$PROJECT_DIR/backups"

# Load env variables for DB credentials
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

DB_USER="${POSTGRES_USER:-postgres}"
DB_NAME="${POSTGRES_DB:-playphoto_bot}"

# Determine backup file
if [ "${1:-}" = "latest" ] || [ -z "${1:-}" ]; then
  BACKUP_FILE=$(ls -t "$BACKUP_DIR"/backup_*.sql.gz 2>/dev/null | head -1)
  if [ -z "$BACKUP_FILE" ]; then
    echo "ERROR: No backup files found in $BACKUP_DIR"
    exit 1
  fi
  echo "Using latest backup: $BACKUP_FILE"
else
  BACKUP_FILE="$1"
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: Backup file not found: $BACKUP_FILE"
  exit 1
fi

echo ""
echo "========================================"
echo "  DATABASE RESTORE"
echo "========================================"
echo "  File: $BACKUP_FILE"
echo "  DB:   $DB_NAME"
echo "  User: $DB_USER"
echo "========================================"
echo ""
echo "WARNING: This will OVERWRITE the current database!"
echo "Press Ctrl+C within 5 seconds to cancel..."
sleep 5

echo "[$(date)] Stopping bot service..."
docker compose -f "$PROJECT_DIR/docker-compose.yml" stop bot 2>/dev/null || true

echo "[$(date)] Restoring database from backup..."
gunzip -c "$BACKUP_FILE" | docker compose -f "$PROJECT_DIR/docker-compose.yml" exec -T postgres \
  psql -U "$DB_USER" -d "$DB_NAME" --quiet --no-psqlrc

echo "[$(date)] Running Prisma migrations to ensure schema is up to date..."
MIGRATION_DB_URL="$(grep '^DATABASE_URL=' "$PROJECT_DIR/.env" | cut -d= -f2- | sed 's/@localhost:/@postgres:/')"
docker compose -f "$PROJECT_DIR/docker-compose.yml" run --rm \
  -e DATABASE_URL="$MIGRATION_DB_URL" \
  bot npx prisma migrate deploy 2>/dev/null || true

echo "[$(date)] Starting bot service..."
docker compose -f "$PROJECT_DIR/docker-compose.yml" up -d bot

echo "[$(date)] Restore completed successfully!"
echo ""
echo "Available backups:"
ls -lh "$BACKUP_DIR"/backup_*.sql.gz 2>/dev/null | tail -5
