#!/bin/bash
set -e
export TS=$(date +%s)
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    wso2ipw screenshot "failure-${TS}.png" 2>/dev/null || true
  fi
  wso2ipw close 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
DIR="$(cd "$(dirname "$0")" && pwd)"
for f in "$DIR"/0*.sh; do bash "$f"; done
