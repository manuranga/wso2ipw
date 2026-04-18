#!/bin/bash
set -e

wso2ipw click g:"getByText(/^HelloWorld/)"
wso2ipw click g:"getByRole('button', {name: /Add Artifact/})"
wso2ipw click g:"getByText('HTTP Service')"
wso2ipw click g:"getByRole('button', {name: 'Create', exact: true})"
wso2ipw wait-for-text "Resources"

