#!/bin/bash
set -e

wso2ipw click g:"getByRole('button', {name: 'Create', exact: true})"
wso2ipw wait-for-text "Integration Name"

wso2ipw fill g:"getByRole('textbox', {name: /Integration Name/})" "HelloWorld"
wso2ipw fill g:"getByRole('textbox', {name: /Project Name/})" "HelloProject"

wso2ipw click g:"getByRole('button', {name: 'Create Integration'})"

wso2ipw wait-for-text "Deployment Options" --timeout=15000
