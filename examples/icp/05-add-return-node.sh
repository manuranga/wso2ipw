#!/bin/bash
set -e

wso2ipw click g:"getByRole('button', {name: /add-node-empty/})"
wso2ipw click g:"getByRole('button', {name: 'Return', exact: true})"
wso2ipw fill g:".cm-content" '"Hello, World!"'
wso2ipw click g:"getByRole('button', {name: 'Save', exact: true})"
wso2ipw wait-for-text "Saving" --hidden --timeout=30000
