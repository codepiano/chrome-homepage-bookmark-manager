#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

corepack pnpm install

echo "Installed Chrome homepage bookmark manager dependencies."
