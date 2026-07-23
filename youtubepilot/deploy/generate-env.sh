#!/usr/bin/env bash
set -euo pipefail
DOMAIN=${1:-}
if [[ -z "$DOMAIN" ]]; then echo "Usage: ./deploy/generate-env.sh <public-hostname>" >&2; exit 1; fi
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then echo "Hostname contains unsupported characters." >&2; exit 1; fi
if [[ -e .env ]]; then echo ".env already exists. Refusing to overwrite secrets." >&2; exit 1; fi
POSTGRES_PASSWORD=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -base64 64 | tr -d '\n')
SESSION_ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n')
SIGNUP_INVITE_CODE=$(openssl rand -hex 16)
cat > .env <<ENV
APP_DOMAIN=$DOMAIN
POSTGRES_DB=youtubepilot
POSTGRES_USER=youtubepilot
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
SESSION_SECRET=$SESSION_SECRET
SESSION_ENCRYPTION_KEY=$SESSION_ENCRYPTION_KEY
SIGNUP_INVITE_CODE=$SIGNUP_INVITE_CODE
WORKER_INTERVAL_SECONDS=20
WORKER_CONCURRENCY=1
MAX_VIDEO_MB=1000
MAX_IMAGE_MB=10
MAX_CAPTION_MB=5
MAX_EXCEL_MB=10
MAX_STORAGE_MB_PER_USER=4096
LOGIN_SESSION_MINUTES=20
ENV
chmod 600 .env
printf 'Created .env for https://%s\nCustomer invitation code: %s\n' "$DOMAIN" "$SIGNUP_INVITE_CODE"
