#!/bin/bash
set -e

INTEGRATION_NAME=${INTEGRATION_NAME:-"HelloWorld"}

wso2ipw wait-for-text "Create New Integration"
wso2ipw click g:"getByRole('button', {name: 'Create', exact: true})"
wso2ipw fill g:"getByRole('textbox', {name: /Integration Name/})" "$INTEGRATION_NAME"
PROJECT_NAME=${PROJECT_NAME:-"HelloProject"}
wso2ipw fill g:"getByRole('textbox', {name: /Project Name/})" "$PROJECT_NAME"
wso2ipw click g:"getByRole('button', {name: 'Create Integration'})"
wso2ipw wait-for-text "Deployment Options" --timeout=15000

