#!/usr/bin/env bash
# Usage: unregister-validator.sh <valoper> [from_key]
# Withdraw a validator from the program (operator or admin key). Its stake is
# redelegated away at the next epoch.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
[ $# -ge 1 ] || { echo "usage: $0 <valoper> [from_key]" >&2; exit 1; }
FROM="${2:-$FROM}"
execute "{\"unregister_participation\":{\"valoper\":\"$1\"}}"
