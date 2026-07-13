#!/usr/bin/env bash
# Usage: pay-tip.sh <valoper> <amount_nhash>
# Pay a priority TIP for the current epoch on a validator's behalf (any payer).
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
[ $# -ge 2 ] || { echo "usage: $0 <valoper> <amount_nhash>" >&2; exit 1; }
execute "{\"pay_tip\":{\"valoper\":\"$1\"}}" --amount "${2}${UNDERLYING}"
smart '{"validators":{}}' "[.data.validators[] | select(.valoper==\"$1\") | {tip_epoch}]"
