#!/bin/bash
set -e

INTEGRATION_NAME=${INTEGRATION_NAME:-"HelloWorld"}
PROJECT_NAME=${PROJECT_NAME:-"HelloProject"}

# Heading differs across Integrator versions
WELCOME_HEADING="/Create New Integration|Start your Integration Project|Create a Project/"

wso2ipw wait-for-text "$WELCOME_HEADING"

create_integration() {
  wso2ipw click g:"getByRole('button', {name: 'Create', exact: true})"
  wso2ipw fill g:"getByRole('textbox', {name: /Integration Name/i})" "$INTEGRATION_NAME"
  wso2ipw fill g:"getByRole('textbox', {name: /Project Name/i})" "$PROJECT_NAME"
  wso2ipw click g:"getByRole('button', {name: /^Create( Integration)?$/})"
  wso2ipw wait-for-text "Deployment Options" --timeout=120000
}

MAX=5
for attempt in $(seq 1 $MAX); do
  if create_integration; then break; fi

  if [ "$attempt" -eq "$MAX" ]; then
    echo "❌ Create Integration failed after $attempt attempts"
    exit 1
  fi
  echo "Attempt $attempt failed, restarting app..."
  wso2ipw close
  wso2ipw open
  wso2ipw wait-for-text "Skip for now"
  wso2ipw click h:"getByRole('button', {name: 'Skip for now'})"
  wso2ipw wait-for-text "$WELCOME_HEADING"
done
