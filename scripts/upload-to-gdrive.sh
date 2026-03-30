#!/bin/bash
# =============================================================================
# Google Drive Upload Script (Service Account Version)
# Uploads a file to Google Drive using a Service Account JSON key
# Usage: ./scripts/upload-to-gdrive.sh <file-path>
# =============================================================================

set -euo pipefail

FILE_PATH="${1:-}"
if [ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ]; then
  echo "ERROR: File not found: $FILE_PATH"
  exit 1
fi

PROJECT_DIR="/Users/vitaliikuznetsov/PlayPhoto/playphoto_hr_bot"
KEY_FILE="$PROJECT_DIR/google-service-account.json"

if [ ! -s "$KEY_FILE" ]; then
  echo "WARNING: Service account key file is empty or missing. Skipping upload."
  exit 0
fi

# Helper: extract JSON field value (works without jq)
json_val() {
  local json="$1" field="$2"
  if command -v jq &>/dev/null; then
    echo "$json" | jq -r ".$field // empty" 2>/dev/null
  else
    echo "$json" | grep -o "\"$field\":\"[^\"]*\"" | cut -d'"' -f4 | head -1
  fi
}

FILENAME=$(basename "$FILE_PATH")
echo "[$(date)] Uploading $FILENAME using Service Account..."

# 1. Get Access Token (simplified for service account using python)
# Note: Google Auth for service accounts requires signing a JWT. 
# It's easiest to use python or node if available.
ACCESS_TOKEN=$(python3 - <<EOF
import time
import json
import base64
import hmac
import hashlib
import urllib.request
import urllib.parse

with open("$KEY_FILE") as f:
    key = json.load(f)

now = int(time.time())
header = base64.urlsafe_b64encode(json.dumps({"alg": "RS256", "typ": "JWT"}).encode()).decode().strip("=")
payload = base64.urlsafe_b64encode(json.dumps({
    "iss": key["client_email"],
    "scope": "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly",
    "aud": "https://oauth2.googleapis.com/token",
    "exp": now + 3600,
    "iat": now
}).encode()).decode().strip("=")

# Since we don't want to mess with complex RSA signing in pure shell/python without libraries, 
# and the server has node_modules, we'll try to use a small node script if python fails or we can just use node.
EOF
)

# Plan B: Use a small Node.js script since we know node is installed and has googleapis
ACCESS_TOKEN=$(node -e "
const { google } = require('googleapis');
const auth = new google.auth.GoogleAuth({
  keyFile: '$KEY_FILE',
  scopes: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive'],
});
auth.getAccessToken().then(token => console.log(token)).catch(err => { console.error(err); process.exit(1); });
" 2>/dev/null || echo "")

if [ -z "$ACCESS_TOKEN" ]; then
  echo "ERROR: Failed to obtain access token via Service Account."
  exit 1
fi

# Step 2: Create folder "PlayPhoto_Backups" or find existing
# (Same logic as before, but using the new token)
FOLDER_ID=$(curl -s -G "https://www.googleapis.com/drive/v3/files" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  --data-urlencode "q=name='PlayPhoto_Backups' and mimeType='application/vnd.google-apps.folder' and trashed=false" \
  --data-urlencode "fields=files(id)" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | head -1 || echo "")

if [ -z "$FOLDER_ID" ]; then
  FOLDER_ID=$(curl -s -X POST "https://www.googleapis.com/drive/v3/files" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"name": "PlayPhoto_Backups", "mimeType": "application/vnd.google-apps.folder"}' | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | head -1 || echo "")
fi

# Step 3: Upload
echo "[$(date)] Uploading to Google Drive..."
UPLOAD_RESPONSE=$(curl -s -X POST \
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -F "metadata={\"name\": \"$FILENAME\", \"parents\": [\"$FOLDER_ID\"]};type=application/json;charset=UTF-8" \
  -F "file=@$FILE_PATH;type=application/gzip")

FILE_ID=$(echo "$UPLOAD_RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | head -1 || echo "")

if [ -n "$FILE_ID" ]; then
  echo "[$(date)] ✅ Success! Uploaded to Google Drive (ID: $FILE_ID)"
else
  echo "[$(date)] ❌ ERROR: Upload failed. Response: $UPLOAD_RESPONSE"
  exit 1
fi
