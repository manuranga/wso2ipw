#!/bin/bash
set -e

wso2ipw open
wso2ipw wait-for-text "Skip for now"
wso2ipw click h:"getByRole('button', {name: 'Skip for now'})"
wso2ipw wait-for-text "Create New Integration"
