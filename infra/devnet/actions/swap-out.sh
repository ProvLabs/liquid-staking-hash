#!/usr/bin/env bash
# Usage: swap-out.sh <shares_nvhash> [from_key]   (default from: account-2)
# Queue a redemption of nvHASH shares (60-day ceiling; expedited when funded).
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
[ $# -ge 1 ] || { echo "usage: $0 <shares_nvhash> [from_key]" >&2; exit 1; }
FROM="${2:-account-2}"
resolve
ADDR="$(addr_of "$FROM")"
tx --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
  vault swap-out "$ADDR" "$VAULT" "${1}${SHARE}"
qj vault vault-pending-swap-outs "$VAULT" | jq '.pending_swap_outs'
