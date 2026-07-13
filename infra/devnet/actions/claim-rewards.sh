#!/usr/bin/env bash
# Claim staking rewards from every delegated validator (permissionless).
# Keepers run this shortly before run-epoch.sh so the epoch's NAV step
# includes the current epoch's rewards.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
execute '{"claim_rewards":{}}'
resolve
qj bank balances "$CONTRACT" | jq '{contract_liquid: [.balances[] | select(.denom=="nhash")]}'
