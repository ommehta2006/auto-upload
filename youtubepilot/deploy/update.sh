#!/usr/bin/env bash
set -euo pipefail
if [[ ! -f docker-compose.yml || ! -f .env ]]; then
  echo "Run this script from the YouTubePilot project directory." >&2
  exit 1
fi
./deploy/backup.sh
docker compose build --pull
docker compose up -d --remove-orphans
docker compose ps
echo "Update complete. Check logs with: docker compose logs -f --tail=200 app"
