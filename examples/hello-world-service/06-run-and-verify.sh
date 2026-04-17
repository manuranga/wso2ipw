#!/bin/bash
set -e

wso2ipw click h:"getByRole('button', {name: 'Run Integration'})"

for i in $(seq 1 30); do
  RESPONSE=$(curl -s http://localhost:9090/hello 2>/dev/null || true)
  if [ "$RESPONSE" = "Hello, World!" ]; then
    echo "✅ GET /hello → $RESPONSE"
    wso2ipw screenshot 06-running.png
    exit 0
  fi
  sleep 1
done

echo "❌ Service did not start in time"
exit 1
