#!/bin/bash
set -e

wso2ipw click g:"getByText(/^HelloWorld/)"
wso2ipw wait-for-text "Your integration is empty"

wso2ipw click g:"getByRole('button', {name: /Add Artifact/})"
wso2ipw wait-for-text "Integration as API"

wso2ipw click g:"getByText('HTTP Service')"
wso2ipw wait-for-text "Service Base Path"

wso2ipw click g:"getByRole('button', {name: 'Create', exact: true})"
wso2ipw wait-for-text "Resources"
