#!/bin/bash
set -e

wso2ipw click g:"getByText('Run', {exact: true})"

RESPONSE=$(curl -s --retry 15 --retry-delay 3 --retry-connrefused http://localhost:9090/hello)
if [ "$RESPONSE" = "Hello, World!" ]; then
  echo "✅ GET /hello → $RESPONSE"
else
  echo "❌ Expected 'Hello, World!' but got: $RESPONSE"
  exit 1
fi

wso2ipw wait-for-text "ICP: Running"

