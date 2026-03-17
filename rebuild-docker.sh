#!/bin/bash
# rebuild-docker.sh - Rebuild and restart Docker container with latest code

set -e  # Exit on any error

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🔨 PlayPhoto Bot - Docker Rebuild Script${NC}\n"

# Check if docker-compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}❌ docker-compose is not installed${NC}"
    exit 1
fi

# Check if we're in the right directory
if [ ! -f "docker-compose.yml" ]; then
    echo -e "${RED}❌ docker-compose.yml not found. Run this script from the project root directory.${NC}"
    exit 1
fi

# Verify required files exist
if [ ! -f ".env" ]; then
    echo -e "${RED}❌ .env file not found${NC}"
    exit 1
fi

if [ ! -f "google-service-account.json" ]; then
    echo -e "${RED}❌ google-service-account.json not found${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Prerequisites check passed${NC}\n"

# Option to do clean rebuild
FULL_CLEAN=false
if [ "$1" == "--clean" ] || [ "$1" == "-c" ]; then
    FULL_CLEAN=true
    echo -e "${YELLOW}📍 Full clean rebuild requested${NC}\n"
fi

# Step 1: Stop existing containers
echo -e "${YELLOW}1️⃣ Stopping existing containers...${NC}"
docker-compose down || true
echo -e "${GREEN}✓ Containers stopped${NC}\n"

# Step 2: Build image
echo -e "${YELLOW}2️⃣ Building Docker image...${NC}"
if [ "$FULL_CLEAN" = true ]; then
    docker-compose build --no-cache
else
    docker-compose build
fi
echo -e "${GREEN}✓ Docker image built${NC}\n"

# Step 3: Start containers
echo -e "${YELLOW}3️⃣ Starting containers...${NC}"
docker-compose up -d
echo -e "${GREEN}✓ Containers started${NC}\n"

# Step 4: Wait for services to be ready
echo -e "${YELLOW}4️⃣ Waiting for services to be ready...${NC}"
sleep 3

# Check if bot is running
if docker-compose ps bot | grep -q "Up"; then
    echo -e "${GREEN}✓ Bot is running${NC}\n"
else
    echo -e "${RED}❌ Bot failed to start. Check logs:${NC}"
    docker-compose logs bot
    exit 1
fi

# Step 5: Optional - Run health check
echo -e "${YELLOW}5️⃣ Running health check...${NC}"
sleep 2

if docker-compose exec -T bot npx tsx src/scripts/health-check-docker.ts 2>&1; then
    echo -e "${GREEN}✓ Health check passed!${NC}\n"
else
    echo -e "${YELLOW}⚠️  Health check failed. This might be normal on first startup.${NC}"
    echo -e "${YELLOW}Run manually with: docker-compose exec bot npx tsx src/scripts/health-check-docker.ts${NC}\n"
fi

# Summary
echo -e "${GREEN}===========================================${NC}"
echo -e "${GREEN}✅ Docker rebuild completed successfully!${NC}"
echo -e "${GREEN}===========================================${NC}\n"

echo "Next steps:"
echo "  1. Check logs:        docker-compose logs -f bot"
echo "  2. Run health check:  docker-compose exec bot npx tsx src/scripts/health-check-docker.ts"
echo "  3. Test in Telegram:  Try Full Sync button"
echo ""
echo "If issues persist, check DOCKER_TROUBLESHOOTING.md"
