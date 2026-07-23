#!/bin/bash
set -e
cd "$(dirname "$0")"
docker compose --env-file .env.local -f docker-compose.local.yml down
echo "YouTubePilot stopped."
