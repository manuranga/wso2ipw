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

# Debug: check if Config.toml has bridge config
CONFIG_TOML=$(find ~/WSO2Integrator -name Config.toml -path '*/target/*' 2>/dev/null | head -1)
if [ -n "$CONFIG_TOML" ]; then
  echo "Config.toml: $CONFIG_TOML"
  cat "$CONFIG_TOML"
else
  echo "⚠️  No Config.toml found in target/"
  find ~/WSO2Integrator -name Config.toml 2>/dev/null
fi
