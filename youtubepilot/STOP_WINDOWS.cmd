@echo off
cd /d "%~dp0"
docker compose --env-file .env.local -f docker-compose.local.yml down
echo YouTubePilot stopped.
pause
