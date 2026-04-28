#!/bin/bash
set -e

for i in $(seq 1 30); do
  RESPONSE=$(curl -s http://localhost:9090/hello 2>/dev/null || true)
  if [ "$RESPONSE" = "Hello, World!" ]; then
    echo "✅ GET /hello → $RESPONSE"
    break
  fi
  sleep 2
done

if [ "$RESPONSE" != "Hello, World!" ]; then
  echo "❌ Service did not respond within 60s"
  exit 1
fi

wso2ipw wait-for-text "ICP: Running"
wso2ipw terminal
echo "---"
