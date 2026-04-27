#!/bin/bash
set -e
TS=$(date +%s)
export INTEGRATION_NAME="HelloWorld${TS}"
export PROJECT_NAME="HelloProject${TS}"

# Kill leftover ICP server Java process
lsof -ti :9450 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

trap 'wso2ipw close 2>/dev/null' EXIT
DIR="$(cd "$(dirname "$0")" && pwd)"
for f in "$DIR"/0[1-7]*.sh; do bash "$f"; done

# ICP dashboard verification is best-effort (runtime bridge registration is slow)
bash "$DIR"/08-verify-icp.sh || echo "⚠️  ICP dashboard verification failed (non-fatal)"
