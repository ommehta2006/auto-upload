# Windows and macOS local deployment

Both desktop versions use the same Docker images and code, so behavior is consistent with Railway.

## Requirements

- Docker Desktop with Docker Compose.
- Node.js 20+ only for generating local secrets.
- At least 4 GB free RAM and enough disk for uploaded videos.

## Windows

1. Extract the ZIP.
2. Start Docker Desktop.
3. Double-click `START_WINDOWS.cmd`.
4. The script creates `.env.local`, builds containers and opens `http://localhost:8080`.
5. The terminal prints the private registration invitation code on first launch.
6. Use `STOP_WINDOWS.cmd` to stop containers without deleting data.

## macOS

1. Extract the ZIP.
2. Start Docker Desktop.
3. If macOS blocks the script, right-click `START_MAC.command`, select **Open**, and confirm.
4. The script creates `.env.local`, builds containers and opens `http://localhost:8080`.
5. Use `STOP_MAC.command` to stop containers.

## Reset local data

This permanently deletes the local database and private media:

```bash
docker compose --env-file .env.local -f docker-compose.local.yml down -v
```

## View logs

```bash
docker compose --env-file .env.local -f docker-compose.local.yml logs -f app
```
