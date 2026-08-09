#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source "./scripts/service-common.sh"

LOG_FILE=".control-panel/api.log"

mkdir -p data .control-panel

if ./scripts/status.sh >/dev/null 2>&1; then
  echo "Chrome homepage bookmark API is already running."
  exit 0
fi

tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use; refusing to start the bookmark API." >&2
  exit 1
fi

tmux new-session -d -s "$SESSION_NAME" -c "$PWD" \
  "exec env PORT='$PORT' SPEED_DIAL_DATA_DIR='$DATA_DIR' corepack pnpm --filter @local-speed-dial/server dev >> '$LOG_FILE' 2>&1"

for _ in $(seq 1 30); do
  if ./scripts/status.sh >/dev/null 2>&1; then
    echo "Started Chrome homepage bookmark API at http://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 0.5
done

echo "Bookmark API failed to start. See $LOG_FILE" >&2
exit 1
