#!/bin/bash
set -e

wso2ipw click h:"getByRole('button', {name: 'Run Integration'})"

for i in $(seq 1 60); do
  RESPONSE=$(curl -s http://localhost:9090/hello 2>/dev/null || true)
  if [ "$RESPONSE" = "Hello, World!" ]; then
    echo "✅ GET /hello → $RESPONSE"
    exit 0
  fi
  sleep 2
done

echo "❌ Service did not respond within 120s"
exit 1
