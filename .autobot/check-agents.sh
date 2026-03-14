#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_PATH="${CONFIG_PATH:-$ROOT_DIR/.autobot/config.json}"

cd "$ROOT_DIR"
if [[ $# -ge 2 && "$1" == "--task-id" ]]; then
  pnpm --silent zoe check --config "$CONFIG_PATH" --task-id "$2"
else
  pnpm --silent zoe check --config "$CONFIG_PATH"
fi
