#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source "./scripts/service-common.sh"

if ! api_is_healthy; then
  exit 1
fi

if tmux has-session -t "$SESSION_NAME" >/dev/null 2>&1; then
  echo "Chrome homepage bookmark API is running in tmux."
  exit 0
fi

if managed_pids="$(managed_api_pids)" && [[ -n "$managed_pids" ]]; then
  echo "Chrome homepage bookmark API is running outside tmux (pid: ${managed_pids//$'\n'/, })."
  exit 0
fi

exit 1
