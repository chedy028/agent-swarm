#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_PATH="${CONFIG_PATH:-$ROOT_DIR/.autobot/config.json}"

if [[ $# -lt 6 ]]; then
  echo "Usage: $0 --id <id> --description <description> --prompt-file <path>"
  exit 1
fi

cd "$ROOT_DIR"
pnpm --silent zoe spawn --config "$CONFIG_PATH" "$@"
