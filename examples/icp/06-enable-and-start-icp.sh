#!/bin/bash
set -e

wso2ipw click g:"getByRole('button', {name: 'Close Panel'})"

wso2ipw wait 1000
wso2ipw click g:"getByRole('button', {name: /HelloWorld/})"
wso2ipw wait-for-text "Integration Control Plane"

wso2ipw click g:"getByRole('checkbox', {name: 'Enable ICP monitoring'})"
wso2ipw wait-for-text "View in ICP"


lsof -ti :9450 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

# Start ICP via the status bar button
wso2ipw click h:"getByRole('button', {name: /ICP: Stopped/})"
wso2ipw wait-for-text "ICP: Running" --timeout=30000

# Verify ICP server logs and stability
wso2ipw wait-for-terminal "ICP server initialization completed successfully" --terminal="ICP Server" --timeout=15000
wso2ipw wait 3000
wso2ipw wait-for-text "ICP: Running"

