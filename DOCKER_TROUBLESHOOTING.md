# Diagnosing and Fixing "Requested entity was not found" Error

## Problem Description
After recent pushes, Full Sync button in the bot is showing error:
```
❌ Error: Requested entity was not found.
```

## Root Cause
The Docker container is likely running an **outdated image** that doesn't include the latest code changes.

## Solution Steps

### Step 1: Verify the Issue
Before rebuilding, check if the issue is indeed with the Docker image:

```bash
# Check Docker logs to see the actual error
docker-compose logs -f bot

# You should see something like:
# [ERROR] Requested entity was not found.
```

### Step 2: Rebuild Docker Image with Latest Code

Navigate to the project directory and run:

```bash
cd /Users/vitaliikuznetsov/PlayPhoto/playphoto_hr_bot

# Option A: Full clean rebuild (recommended, takes longer)
docker-compose down
docker-compose build --no-cache
docker-compose up -d

# Option B: Quick rebuild (if you just want to test)
docker-compose build
docker-compose up -d
```

### Step 3: Verify the Fix

Run the health check script inside the Docker container:

```bash
# Execute health check inside the running container
docker-compose exec bot npx tsx src/scripts/health-check-docker.ts

# Expected output:
# 🏥 Running Health Check for Google Sheets Integration
# ✓ Passed: 12
# ✗ Failed: 0
# ✓ All checks passed! Google Sheets integration is working.
```

### Step 4: Test Full Sync
- Open the admin panel in Telegram
- Click "🔄 Full Sync"
- It should now complete successfully with a message like:
```
✅ Synchronization complete!

👥 Team: +X new, Y updated.
📅 Schedule: +Z shifts added.
```

## Debugging (if issue persists)

### Check Docker logs for detailed errors:
```bash
docker-compose logs bot | tail -100
```

### Run health check with more details:
```bash
docker-compose exec bot npx tsx src/scripts/health-check-docker.ts --verbose
```

### Common Issues and Solutions:

| Issue | Solution |
|-------|----------|
| `ENOENT: google-service-account.json not found` | Ensure file is mapped in docker-compose.yml volume |
| `GOOGLE_REFRESH_TOKEN not set` | Check .env file exists and is passed to container |
| `Invalid JSON in google-service-account.json` | Regenerate credentials from Google Cloud Console |
| `Spreadsheet not found (404)` | Verify SPREADSHEET_ID_TEAM and SPREADSHEET_ID_SCHEDULE are correct |

## What Changed in Recent Commits

The recent commits included important fixes for Google Sheets API integration:
- Proper quoting of sheet names with special characters (Ukrainian characters, spaces)
- Better error logging for sync failures
- Database migration improvements

These changes **must be deployed** to Docker for the bot to work correctly.

## Docker Environment Setup

The bot uses:
- **Local build**: Builds from Dockerfile on startup
- **Image**: `ghcr.io/kuznetsov96/playphoto-hr-bot:latest` (pre-built, may be outdated)
- **Volumes**:
  - `.env` → environment variables
  - `google-service-account.json` → Google credentials
  - `./logs` → application logs

## Verification Checklist

Before and after rebuild:
- [ ] `.env` file exists and has all required variables
- [ ] `google-service-account.json` exists and is valid JSON
- [ ] Docker container is running: `docker-compose ps`
- [ ] Bot responds to commands in Telegram
- [ ] Full Sync button works and shows results
- [ ] Health check passes: `docker-compose exec bot npx tsx src/scripts/health-check-docker.ts`
