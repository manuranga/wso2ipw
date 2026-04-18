#!/bin/bash
set -e
TS=$(date +%s)
export INTEGRATION_NAME="HelloWorld${TS}"
export PROJECT_NAME="HelloProject${TS}"

# Workaround for ICP server Java process survives app close bug
lsof -ti :9450 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

trap 'wso2ipw close 2>/dev/null' EXIT
DIR="$(cd "$(dirname "$0")" && pwd)"
for f in "$DIR"/0*.sh; do bash "$f"; done
