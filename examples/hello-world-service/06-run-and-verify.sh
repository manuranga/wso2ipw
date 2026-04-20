#!/bin/bash
set -e

wso2ipw click h:"getByRole('button', {name: 'Run Integration'})"
wso2ipw wait-for-terminal "Running executable" --timeout=120000

RESPONSE=$(curl -s --retry 5 --retry-delay 1 --retry-connrefused http://localhost:9090/hello)
if [ "$RESPONSE" = "Hello, World!" ]; then
  echo "✅ GET /hello → $RESPONSE"
else
  echo "❌ Expected 'Hello, World!' but got: $RESPONSE"
  exit 1
fi
