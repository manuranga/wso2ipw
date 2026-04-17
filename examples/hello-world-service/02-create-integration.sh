#!/bin/bash
set -e

TS=${TS:-$(date +%s)}
export INTEGRATION_NAME="HelloWorld${TS}"
export PROJECT_NAME="HelloProject${TS}"

wso2ipw click g:"getByRole('button', {name: 'Create', exact: true})"
wso2ipw wait-for-text "Integration Name"

wso2ipw fill g:"getByRole('textbox', {name: /Integration Name/})" "$INTEGRATION_NAME"
wso2ipw fill g:"getByRole('textbox', {name: /Project Name/})" "$PROJECT_NAME"

wso2ipw click g:"getByRole('button', {name: 'Create Integration'})"

wso2ipw wait-for-text "Deployment Options" --timeout=15000
