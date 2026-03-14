#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_PATH="${CONFIG_PATH:-$ROOT_DIR/.autobot/config.json}"

cd "$ROOT_DIR"
if [[ "${1:-}" == "--dry-run" ]]; then
  pnpm --silent zoe cleanup --config "$CONFIG_PATH" --dry-run
else
  pnpm --silent zoe cleanup --config "$CONFIG_PATH"
fi
