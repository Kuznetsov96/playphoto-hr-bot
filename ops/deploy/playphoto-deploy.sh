#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <image-tag> <github-actor> <repo-lc>" >&2
  exit 64
fi

IMAGE_TAG="$1"
GITHUB_ACTOR="$2"
REPO_LC="$3"

if [ -z "${GHCR_TOKEN:-}" ]; then
  echo "GHCR_TOKEN is required" >&2
  exit 64
fi

PROJECT_DIR="/home/playphoto-mgr/playphoto_hr_bot"
SECRETS_DIR="/root/playphoto-secrets"

cd "$PROJECT_DIR"

install -d -m 700 "$SECRETS_DIR"
if [ -f .env ]; then
  install -m 600 -o root -g root .env "$SECRETS_DIR/bot.env"
  rm -f .env
fi
if [ -f google-service-account.json ]; then
  install -m 600 -o root -g root google-service-account.json "$SECRETS_DIR/google-service-account.json"
  rm -f google-service-account.json
fi

chmod +x scripts/backup-db.sh scripts/monitor-disk.sh

echo "=== [1/5] Cleanup Disk ==="
DISK_PCT=$(df / --output=pcent 2>/dev/null | tail -1 | tr -d ' %' || df -h / | awk 'NR==2 {print $5+0}')
if [ "$DISK_PCT" -gt 90 ] 2>/dev/null; then
  echo "Disk usage ${DISK_PCT}%, cleaning..."
  docker system prune -af
fi

echo "=== [2/5] Database Backup ==="
mkdir -p backups logs
export DATABASE_URL="$(grep '^DATABASE_URL=' "$SECRETS_DIR/bot.env" | cut -d= -f2-)"
export BACKUP_PASSPHRASE="$(grep '^BACKUP_PASSPHRASE=' "$SECRETS_DIR/bot.env" | cut -d= -f2-)"
export PROJECT_DIR="$PROJECT_DIR"
export SKIP_GDRIVE_UPLOAD=true
bash scripts/backup-db.sh 2>&1

echo "=== [3/5] Pull & Migrate ==="
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin
docker pull "ghcr.io/$REPO_LC:$IMAGE_TAG"
sed -i "s|ghcr.io/$REPO_LC:.*|ghcr.io/$REPO_LC:$IMAGE_TAG|" docker-compose.yml
docker compose run --rm bot npx prisma migrate deploy

echo "=== [4/5] Restart Bot ==="
docker compose up -d --no-deps loki alloy bot

echo "=== [5/5] Health Check ==="
CONTAINER_ID=$(docker compose ps -q bot)
for i in $(seq 1 24); do
  sleep 5
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER_ID" 2>/dev/null || echo "starting")
  echo "Status: $STATUS ($i/24)"
  if [ "$STATUS" = "healthy" ]; then
    echo "Deployment successful."
    break
  fi
  if [ "$i" -eq 24 ]; then
    echo "Health check failed." >&2
    docker compose logs bot --tail 50
    exit 1
  fi
done

echo "=== [Logging] Validate Loki & Alloy ==="
curl -fsS http://127.0.0.1:3100/ready >/dev/null
curl -fsS http://127.0.0.1:12345/-/ready >/dev/null

docker image prune -f
