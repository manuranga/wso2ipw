#!/bin/bash
set -e

wso2ipw click g:"getByRole('button', {name: /add-node-empty/})"
wso2ipw click g:"getByRole('button', {name: 'Return', exact: true})"
wso2ipw fill g:".cm-content" '"Hello, World!"'
wso2ipw click g:"getByRole('button', {name: 'Save', exact: true})"
# After save, view may show "Try It" immediately (Linux) or stay on flow view (Windows).
# Wait for save to finish ("Saving..." disappears), then check for "Try It".
wso2ipw wait-for-text "Try It" --timeout=30000 || true
