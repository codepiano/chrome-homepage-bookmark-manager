#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p data .control-panel
corepack pnpm install

echo "Initialized Chrome homepage bookmark manager."
