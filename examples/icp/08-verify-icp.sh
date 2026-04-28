#!/bin/bash
set -e

PC="npx playwright-cli"

INTEGRATION_NAME=${INTEGRATION_NAME:-"HelloWorld"}
PROJECT_NAME=${PROJECT_NAME:-"HelloProject"}
ICP_PROJECT=$(echo "$PROJECT_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[0-9]*$//')
ICP_INTEGRATION=$(echo "$INTEGRATION_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[0-9]*$//')

$PC open --headed "https://localhost:9446"
sleep 3

$PC fill 'input[placeholder="Enter username"]' "admin"
$PC fill 'input[placeholder="Enter password"]' "admin"
$PC click 'button:has-text("Sign In")'
sleep 3

$PC click "h6:has-text(\"$ICP_PROJECT\")"
sleep 2
$PC click "td:has-text(\"$ICP_INTEGRATION\")"

for i in $(seq 1 30); do
  sleep 5
  $PC goto "https://localhost:9446/organizations/default/projects/$ICP_PROJECT/components/$ICP_INTEGRATION" 2>/dev/null || true
  sleep 2
  SNAPSHOT=$($PC snapshot 2>&1)
  if echo "$SNAPSHOT" | grep -q "1/1 Online"; then break; fi
  echo "Waiting for runtime to come online... ($i/30)"
done

if ! echo "$SNAPSHOT" | grep -q "1/1 Online"; then
  echo "$SNAPSHOT"
  echo "❌ Runtime not online in ICP"
  exit 1
fi
echo "$SNAPSHOT" | grep -q "/hello" || { echo "❌ GET /hello endpoint not found in ICP"; exit 1; }
echo "✅ ICP dashboard: $ICP_INTEGRATION 1/1 Online, /hello"

$PC close
