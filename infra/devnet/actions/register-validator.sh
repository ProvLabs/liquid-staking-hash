#!/usr/bin/env bash
# Usage: register-validator.sh [key_name]
# Enroll the validator whose operator is the given keyring key (default:
# validator). The tx is signed by that key; the valoper is derived from it.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
KEY="${1:-validator}"
FROM="$KEY"
VALOPER="$(valoper_of "$KEY")"
echo "registering $VALOPER (operator key: $KEY)"
execute "{\"register_participation\":{\"valoper\":\"$VALOPER\"}}"
smart '{"validators":{}}' '[.data.validators[] | {valoper, eligible, headroom}]'
