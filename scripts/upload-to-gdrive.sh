#!/bin/bash
# =============================================================================
# Google Drive Upload Script
# Uploads a file to Google Drive using OAuth2 credentials from .env
# Usage: ./scripts/upload-to-gdrive.sh <file-path>
#
# Required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
# Optional env var:  GDRIVE_BACKUP_FOLDER_ID (Google Drive folder ID for backups)
# =============================================================================

set -euo pipefail

FILE_PATH="${1:-}"
if [ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ]; then
  echo "ERROR: File not found: $FILE_PATH"
  exit 1
fi

PROJECT_DIR="${PROJECT_DIR:-/root/playphoto_hr_bot}"

# Load env variables from .env.gdrive (OAuth2 for Google Drive)
# This is separate from the main .env to allow the bot to use service account
# while backup scripts use OAuth2 for Drive access
if [ -f "$PROJECT_DIR/.env.gdrive" ]; then
  set -a
  source "$PROJECT_DIR/.env.gdrive"
  set +a
elif [ -f "$PROJECT_DIR/.env" ]; then
  # Fallback to .env if .env.gdrive doesn't exist
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

# Check required credentials
if [ -z "${GOOGLE_CLIENT_ID:-}" ] || [ -z "${GOOGLE_CLIENT_SECRET:-}" ] || [ -z "${GOOGLE_REFRESH_TOKEN:-}" ]; then
  echo "WARNING: Google OAuth2 credentials not configured. Skipping upload."
  echo "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN in .env"
  exit 0
fi

# Helper: extract JSON field value (works without jq)
json_val() {
  local json="$1" field="$2"
  # Try jq first, fall back to python3, then sed
  if command -v jq &>/dev/null; then
    echo "$json" | jq -r ".$field // empty" 2>/dev/null
  elif command -v python3 &>/dev/null; then
    echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$field',''))" 2>/dev/null
  else
    echo "$json" | sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -1
  fi
}

# Helper: extract array of IDs from Google Drive files response
json_file_ids() {
  local json="$1"
  if command -v jq &>/dev/null; then
    echo "$json" | jq -r '.files[]?.id // empty' 2>/dev/null
  elif command -v python3 &>/dev/null; then
    echo "$json" | python3 -c "import sys,json; [print(f['id']) for f in json.load(sys.stdin).get('files',[])]" 2>/dev/null
  else
    echo "$json" | grep -o '"id":"[^"]*"' | cut -d'"' -f4
  fi
}

FILENAME=$(basename "$FILE_PATH")

echo "[$(date)] Uploading $FILENAME to Google Drive..."

# Step 1: Get access token using refresh token
TOKEN_RESPONSE=$(curl -s -X POST "https://oauth2.googleapis.com/token" \
  -d "client_id=$GOOGLE_CLIENT_ID" \
  -d "client_secret=$GOOGLE_CLIENT_SECRET" \
  -d "refresh_token=$GOOGLE_REFRESH_TOKEN" \
  -d "grant_type=refresh_token")

ACCESS_TOKEN=$(json_val "$TOKEN_RESPONSE" "access_token")

if [ -z "$ACCESS_TOKEN" ]; then
  echo "ERROR: Failed to obtain access token. Response: $TOKEN_RESPONSE"
  exit 1
fi

echo "[$(date)] Access token obtained successfully"

# Step 2: Create folder "PlayPhoto_Backups" if GDRIVE_BACKUP_FOLDER_ID not set
FOLDER_ID="${GDRIVE_BACKUP_FOLDER_ID:-}"

if [ -z "$FOLDER_ID" ]; then
  # Search for existing folder
  SEARCH_RESPONSE=$(curl -s -G "https://www.googleapis.com/drive/v3/files" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    --data-urlencode "q=name='PlayPhoto_Backups' and mimeType='application/vnd.google-apps.folder' and trashed=false" \
    --data-urlencode "fields=files(id)")

  FOLDER_ID=$(json_file_ids "$SEARCH_RESPONSE" | head -1)

  if [ -z "$FOLDER_ID" ]; then
    # Create the folder
    CREATE_RESPONSE=$(curl -s -X POST "https://www.googleapis.com/drive/v3/files" \
      -H "Authorization: Bearer $ACCESS_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"name": "PlayPhoto_Backups", "mimeType": "application/vnd.google-apps.folder"}')
    FOLDER_ID=$(json_val "$CREATE_RESPONSE" "id")
    echo "[$(date)] Created Google Drive folder: PlayPhoto_Backups ($FOLDER_ID)"
  else
    echo "[$(date)] Found existing folder: $FOLDER_ID"
  fi
fi

if [ -z "$FOLDER_ID" ]; then
  echo "ERROR: Could not create or find Google Drive folder"
  exit 1
fi

# Step 3: Upload the file
echo "[$(date)] Uploading to folder $FOLDER_ID..."
UPLOAD_RESPONSE=$(curl -s -X POST \
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -F "metadata={\"name\": \"$FILENAME\", \"parents\": [\"$FOLDER_ID\"]};type=application/json;charset=UTF-8" \
  -F "file=@$FILE_PATH;type=application/gzip")

FILE_ID=$(json_val "$UPLOAD_RESPONSE" "id")

if [ -n "$FILE_ID" ]; then
  echo "[$(date)] Uploaded to Google Drive: $FILENAME (ID: $FILE_ID)"
else
  echo "[$(date)] ERROR: Upload failed. Response: $UPLOAD_RESPONSE"
  exit 1
fi

# Step 4: Clean up old backups in Google Drive (keep last 30)
LIST_RESPONSE=$(curl -s -G "https://www.googleapis.com/drive/v3/files" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  --data-urlencode "q='$FOLDER_ID' in parents and trashed=false" \
  --data-urlencode "orderBy=createdTime" \
  --data-urlencode "fields=files(id,name)" \
  --data-urlencode "pageSize=100")

OLD_FILES=$(json_file_ids "$LIST_RESPONSE")
COUNT=$(echo "$OLD_FILES" | grep -c . || true)

if [ "$COUNT" -gt 30 ]; then
  DELETE_COUNT=$((COUNT - 30))
  echo "$OLD_FILES" | head -$DELETE_COUNT | while read -r OLD_ID; do
    [ -z "$OLD_ID" ] && continue
    curl -s -X DELETE "https://www.googleapis.com/drive/v3/files/$OLD_ID" \
      -H "Authorization: Bearer $ACCESS_TOKEN" > /dev/null
  done
  echo "[$(date)] Cleaned up $DELETE_COUNT old backups from Google Drive"
fi
