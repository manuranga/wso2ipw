#!/bin/bash
set -e
export TS=$(date +%s)
trap 'wso2ipw close 2>/dev/null' EXIT
DIR="$(cd "$(dirname "$0")" && pwd)"
for f in "$DIR"/0*.sh; do bash "$f"; done
