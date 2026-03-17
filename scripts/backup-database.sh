#!/bin/bash

# PlayPhoto Secure Backup Script (Bank-Grade AES-256-CBC)
# This script performs a full PostgreSQL dump, compresses it, and encrypts it.

# Load environment variables (from project root)
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Using a safer way to load .env
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a
    source "$PROJECT_DIR/.env"
    set +a
else
    echo "❌ .env file not found at $PROJECT_DIR/.env"
    exit 1
fi

# Configuration (defaults if not in .env)
POSTGRES_USER=${POSTGRES_USER:-postgres}
POSTGRES_DB=${POSTGRES_DB:-playphoto}
BACKUP_DIR="$PROJECT_DIR/backups"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
RAW_DUMP="$BACKUP_DIR/db_dump_$TIMESTAMP.sql"
ENC_DUMP="$BACKUP_DIR/db_dump_$TIMESTAMP.sql.enc"
LOG_FILE="$PROJECT_DIR/logs/backup.log"

# Ensure directories exist
mkdir -p "$BACKUP_DIR"
mkdir -p "$PROJECT_DIR/logs"

# Check if encryption key is set
if [ -z "$BACKUP_PASSPHRASE" ]; then
    echo "$(date): ERROR - BACKUP_PASSPHRASE not found in .env. Backup aborted." >> "$LOG_FILE"
    exit 1
fi

# 1. Perform database dump (Assume Dockerized Postgres)
# Replace 'playphoto-db' with your Postgres container name from docker-compose.yml
echo "📦 Starting database dump from Docker container 'playphoto-db'..."
docker exec playphoto-db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > "$RAW_DUMP"

if [ $? -ne 0 ]; then
    echo "$(date): ERROR - pg_dump failed. Check if Docker container 'playphoto-db' is running." >> "$LOG_FILE"
    rm -f "$RAW_DUMP"
    exit 1
fi

# 2. Encrypt the dump (AES-256-CBC)
echo "🔒 Encrypting database dump..."
openssl enc -aes-256-cbc -salt -in "$RAW_DUMP" -out "$ENC_DUMP" -pass "pass:$BACKUP_PASSPHRASE" -pbkdf2

if [ $? -eq 0 ]; then
    echo "$(date): SUCCESS - Encrypted backup created: $ENC_DUMP" >> "$LOG_FILE"
    # 3. Clean up the RAW (unencrypted) dump IMMEDIATELY
    rm -f "$RAW_DUMP"
    
    # 4. Cleanup old backups (Keep last 7 days)
    find "$BACKUP_DIR" -name "*.sql.enc" -type f -mtime +7 -delete
    echo "✅ Backup process complete. Old backups cleaned."
else
    echo "$(date): ERROR - Encryption failed." >> "$LOG_FILE"
    rm -f "$RAW_DUMP"
    exit 1
fi

# RESTORE INSTRUCTIONS (for founder):
# To decrypt: openssl enc -d -aes-256-cbc -in [FILE].sql.enc -out [FILE].sql -pass "pass:[YOUR_BACKUP_PASSPHRASE]" -pbkdf2
