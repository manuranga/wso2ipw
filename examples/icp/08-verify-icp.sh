#!/bin/bash
set -e

INTEGRATION_NAME=${INTEGRATION_NAME:-"HelloWorld"}
PROJECT_NAME=$(echo "$INTEGRATION_NAME" | tr '[:upper:]' '[:lower:]')

playwright-cli open --headed "https://localhost:9446"

playwright-cli fill 'input[placeholder="Enter username"]' "admin"
playwright-cli fill 'input[placeholder="Enter password"]' "admin"
playwright-cli click 'button:has-text("Sign In")'

sleep 3
playwright-cli fill 'input[placeholder="Search projects"]' "$PROJECT_NAME"
sleep 2
playwright-cli screenshot --filename icp-dashboard-screenshots.png

playwright-cli snapshot | grep -q "$PROJECT_NAME" || { echo "❌ Project $PROJECT_NAME not found in ICP"; exit 1; }


playwright-cli click "h6:has-text(\"$PROJECT_NAME\")"
sleep 2

playwright-cli click "td:has-text(\"$PROJECT_NAME\")"
sleep 2
playwright-cli screenshot --filename icp-integration-screenshots.png

SNAPSHOT=$(playwright-cli snapshot)
echo "$SNAPSHOT" | grep -q "1/1 Online" || { echo "❌ Runtime not online in ICP"; exit 1; }
echo "$SNAPSHOT" | grep -q "/hello" || { echo "❌ GET /hello endpoint not found in ICP"; exit 1; }

playwright-cli close

