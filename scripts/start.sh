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

tmux_env=(-e "NODE_USE_ENV_PROXY=1")
for proxy_var in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy; do
  proxy_value="${!proxy_var-}"
  [[ -n "$proxy_value" ]] && tmux_env+=(-e "$proxy_var=$proxy_value")
done

tmux new-session -d -s "$SESSION_NAME" -c "$PWD" "${tmux_env[@]}" \
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
