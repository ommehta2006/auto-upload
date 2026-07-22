#!/usr/bin/env bash
set -euo pipefail
cat <<'WARNING'
This permanently deletes the database, uploaded videos, sessions, screenshots,
and TLS state for this YouTubePilot deployment.
WARNING
read -r -p "Type DELETE-YOUTUBEPILOT to continue: " answer
[[ "$answer" == "DELETE-YOUTUBEPILOT" ]] || { echo "Cancelled."; exit 1; }
docker compose down -v --remove-orphans
rm -rf backups
printf 'Test data deleted. Your .env file was preserved.\n'
