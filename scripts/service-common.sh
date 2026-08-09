#!/usr/bin/env bash

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="chrome-local-speed-dial-api"
PORT="${SPEED_DIAL_PORT:-3721}"
DATA_DIR="${SPEED_DIAL_DATA_DIR:-$ROOT_DIR/data}"
API_HEALTH_URL="http://127.0.0.1:$PORT/health"

project_api_pids() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

is_project_api_pid() {
  local pid="$1"
  local cwd
  local command

  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"

  [[ "$cwd" == "$ROOT_DIR" ]] || return 1
  [[ "$command" == *"apps/server/"* || "$command" == *"src/index.ts"* || "$command" == *"dist/index.js"* ]]
}

managed_api_pids() {
  local pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && is_project_api_pid "$pid" && echo "$pid"
  done < <(project_api_pids)
}

api_is_healthy() {
  curl --fail --silent --max-time 2 "$API_HEALTH_URL" >/dev/null
}
