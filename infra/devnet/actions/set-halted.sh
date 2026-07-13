#!/usr/bin/env bash
# Usage: set-halted.sh <true|false>   (admin key; default FROM=account-1)
# Emergency stop / resume for the fund-moving cranks.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
[ $# -ge 1 ] || { echo "usage: $0 <true|false>" >&2; exit 1; }
execute "{\"set_halted\":{\"halted\":$1}}"
smart '{"epoch_status":{}}' '.data | {halted, phase}'
