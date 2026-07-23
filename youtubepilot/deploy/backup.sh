#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .env ]]; then echo "Run this script from the project directory." >&2; exit 1; fi
set -a; source .env; set +a
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR=${BACKUP_DIR:-./backups/$STAMP}
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists > "$BACKUP_DIR/database.sql"
docker compose exec -T app tar -czf - -C /app/storage . > "$BACKUP_DIR/storage.tar.gz"
cp .env "$BACKUP_DIR/env.backup"
chmod 600 "$BACKUP_DIR/env.backup" "$BACKUP_DIR/database.sql" "$BACKUP_DIR/storage.tar.gz"
echo "Backup created at $BACKUP_DIR"
echo "Protect env.backup: it contains encryption and database secrets."
