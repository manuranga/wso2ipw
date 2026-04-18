#!/bin/bash
set -e

wso2ipw click g:"getByRole('button', {name: /Add Resource/})"
wso2ipw click g:"getByRole('button', {name: 'GET', exact: true})"
wso2ipw fill g:"getByRole('textbox', {name: /Resource Path/})" "hello"
wso2ipw click g:"getByRole('button', {name: 'Save', exact: true})"
wso2ipw wait-for-text "Sequence"

