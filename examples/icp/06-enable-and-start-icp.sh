#!/bin/bash
set -e

wso2ipw wait 1000

# Navigate to integration overview
wso2ipw click g:"getByRole('button', {name: /HelloWorld/})"
wso2ipw wait-for-text "Design"

# Enable ICP monitoring
wso2ipw click g:"getByRole('checkbox', {name: 'Enable ICP monitoring'})"
wso2ipw wait 1000

# Kill leftover ICP server Java processes
kill_port() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti :$1 2>/dev/null | xargs kill -9 2>/dev/null || true
  else
    for pid in $(netstat -ano 2>/dev/null | grep ":$1 " | awk '{print $5}' | sort -u); do
      taskkill //F //PID $pid 2>/dev/null || true
    done
  fi
}
for port in 9445 9446 9450; do kill_port $port; done
sleep 1

# Start ICP
wso2ipw click h:"getByRole('button', {name: /ICP: Stopped/})"
wso2ipw wait-for-text "ICP: Running" --timeout=60000
wso2ipw wait 5000
wso2ipw wait-for-text "ICP: Running"

# Restore flow view so Run Integration has the visualizer panel reference
wso2ipw click h:"getByRole('treeitem', {name: /HTTP Service/})"
wso2ipw wait-for-text "Resources" --timeout=10000
wso2ipw click g:"getByText('GET').first()"
wso2ipw wait-for-text "Sequence" --timeout=10000

# Run the integration
wso2ipw click h:"getByRole('button', {name: 'Run Integration'})"
