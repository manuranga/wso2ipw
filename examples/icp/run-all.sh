#!/bin/bash
set -e
TS=$(date +%s)
export INTEGRATION_NAME="HelloWorld${TS}"
export PROJECT_NAME="HelloProject${TS}"

# Kill leftover ICP server Java processes
kill_port() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti :$1 2>/dev/null | xargs kill -9 2>/dev/null || true
  else
    # Windows (Git Bash): use netstat + taskkill
    for pid in $(netstat -ano 2>/dev/null | grep ":$1 " | awk '{print $5}' | sort -u); do
      taskkill //F //PID $pid 2>/dev/null || true
    done
  fi
}
for port in 9445 9446 9450; do kill_port $port; done
sleep 1

trap 'wso2ipw close 2>/dev/null' EXIT
DIR="$(cd "$(dirname "$0")" && pwd)"
for f in "$DIR"/0[1-7]*.sh; do bash "$f"; done

# ICP dashboard verification is best-effort (runtime bridge registration is slow)
bash "$DIR"/08-verify-icp.sh || echo "⚠️  ICP dashboard verification failed (non-fatal)"
