#!/usr/bin/env bash
# Usage: pay-commission.sh <valoper> [amount_nhash]
# Pay program commission on a validator's behalf (any payer). Default amount:
# the full outstanding balance (accrued - paid).
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
[ $# -ge 1 ] || { echo "usage: $0 <valoper> [amount_nhash]" >&2; exit 1; }
resolve
AMT="${2:-}"
if [ -z "$AMT" ]; then
  AMT="$(smart '{"validators":{}}' ".data.validators[] | select(.valoper==\"$1\") | ((.commission_accrued|tonumber) - (.commission_paid|tonumber))" | head -1)"
  [ -n "$AMT" ] && [ "$AMT" -gt 0 ] 2>/dev/null || { echo "nothing outstanding for $1"; exit 0; }
  echo "paying outstanding commission: $AMT nhash"
fi
execute "{\"pay_commission\":{\"valoper\":\"$1\"}}" --amount "${AMT}${UNDERLYING}"
smart '{"validators":{}}' "[.data.validators[] | select(.valoper==\"$1\") | {commission_accrued, commission_paid, commission_due, in_arrears, eligible}]"
