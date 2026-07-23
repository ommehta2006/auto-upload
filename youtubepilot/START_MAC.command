#!/bin/bash
set -e
cd "$(dirname "$0")"
command -v docker >/dev/null || { echo "Docker Desktop is required."; exit 1; }
[ -f .env.local ] || node deploy/generate-local-env.mjs
set -a; source .env.local; set +a
docker compose --env-file .env.local -f docker-compose.local.yml up -d --build
open http://localhost:8080
echo "YouTubePilot is running at http://localhost:8080"
