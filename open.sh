#!/bin/bash
# Usage: bash open.sh [extra electron args...]
# e.g.   bash open.sh /path/to/project
DIR="$(cd "$(dirname "$0")" && pwd)"
STATE=~/.wso2ipw/test

pkill -f "WSO2.*Electron" 2>/dev/null
pkill -f "daemon.mjs" 2>/dev/null
sleep 1

mkdir -p "$STATE"
rm -f "$STATE/session.json" "$STATE/daemon.log"

WSO2I_STATE_DIR="$STATE" WSO2I_ORIG_CWD="$DIR" node "$DIR/daemon.mjs" "$@" &

until [ -f "$STATE/session.json" ]; do sleep 0.5; done
cat "$STATE/session.json"
