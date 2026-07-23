#!/usr/bin/env bash
set -euo pipefail

PUBLIC_PORT="${PORT:-3000}"
APP_INTERNAL_PORT="${APP_INTERNAL_PORT:-3001}"
export PUBLIC_PORT
export HOME=/home/pwuser

mkdir -p /app/storage /app/tmp
chown -R pwuser:pwuser /app/storage /app/tmp
chmod 700 /app/storage /app/tmp

rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 || true
gosu pwuser Xvfb :99 -screen 0 1440x1000x24 -nolisten tcp -ac > /tmp/xvfb.log 2>&1 &
XVFB_PID=$!
export DISPLAY=:99

for _ in $(seq 1 50); do
  if gosu pwuser xdpyinfo -display :99 >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! gosu pwuser xdpyinfo -display :99 >/dev/null 2>&1; then
  echo "Xvfb failed to start." >&2
  cat /tmp/xvfb.log >&2 || true
  exit 1
fi

gosu pwuser openbox-session > /tmp/openbox.log 2>&1 &
OPENBOX_PID=$!

MIGRATED=false
for attempt in $(seq 1 30); do
  if gosu pwuser env PORT="$APP_INTERNAL_PORT" node src/migrate.js; then
    MIGRATED=true
    break
  fi
  echo "Database migration attempt ${attempt}/30 failed; retrying in 2 seconds..." >&2
  sleep 2
done

if [[ "$MIGRATED" != "true" ]]; then
  echo "Database migration did not succeed after 30 attempts." >&2
  exit 1
fi

gosu pwuser env PORT="$APP_INTERNAL_PORT" node src/server.js &
APP_PID=$!
gosu pwuser caddy run --config /app/Railway.Caddyfile --adapter caddyfile &
PROXY_PID=$!

shutdown() {
  kill -TERM "$APP_PID" "$PROXY_PID" "$OPENBOX_PID" "$XVFB_PID" 2>/dev/null || true
  wait "$APP_PID" "$PROXY_PID" "$OPENBOX_PID" "$XVFB_PID" 2>/dev/null || true
}
trap shutdown SIGTERM SIGINT EXIT

set +e
wait -n "$APP_PID" "$PROXY_PID"
STATUS=$?
set -e
exit "$STATUS"
