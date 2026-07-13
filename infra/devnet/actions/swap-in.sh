#!/usr/bin/env bash
# Usage: swap-in.sh <amount_nhash> [from_key]   (default from: account-2)
# Deposit nHASH into the vault, receiving nvHASH shares at the current NAV.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
[ $# -ge 1 ] || { echo "usage: $0 <amount_nhash> [from_key]" >&2; exit 1; }
FROM="${2:-account-2}"
resolve
ADDR="$(addr_of "$FROM")"
tx --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
  vault swap-in "$ADDR" "$VAULT" "${1}${UNDERLYING}"
qj bank balances "$ADDR" | jq --arg d "$SHARE" '{shares: [.balances[] | select(.denom==$d)]}'
