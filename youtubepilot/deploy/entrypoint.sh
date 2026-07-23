#!/usr/bin/env bash
set -euo pipefail

rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 || true
Xvfb :99 -screen 0 1440x1000x24 -nolisten tcp -ac > /tmp/xvfb.log 2>&1 &
XVFB_PID=$!
export DISPLAY=:99

for _ in $(seq 1 30); do
  if xdpyinfo -display :99 >/dev/null 2>&1; then break; fi
  sleep 0.2
done

openbox-session > /tmp/openbox.log 2>&1 &

node src/migrate.js
exec node src/server.js
