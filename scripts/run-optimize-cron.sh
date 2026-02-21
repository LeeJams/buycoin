#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/Users/jaeminlee/Work/own/buycoin"
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"
LOCK_DIR="$ROOT_DIR/.trader/.optimize-lock"
LOG_DIR="$ROOT_DIR/.trader/cron-logs"
NOW="$(date -u +"%Y%m%d-%H%M%S")"
LOG_FILE="$LOG_DIR/optimizer-$NOW.log"

mkdir -p "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] skip: optimizer already running"
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

cd "$ROOT_DIR"
{
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] start optimize"
  "$NODE_BIN" ./src/app/optimize.js
  status=$?
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] end optimize exit=${status}"
} >> "$LOG_FILE" 2>&1
exit ${status:-1}
