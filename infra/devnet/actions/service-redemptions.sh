#!/usr/bin/env bash
# Service the redemption queue (permissionless): unbond any reserve shortfall
# in drain-priority order and expedite every marker-funded request.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
execute '{"service_redemptions":{}}'
resolve
qj vault vault-pending-swap-outs "$VAULT" | jq '{pending: (.pending_swap_outs | length)}'
qj staking unbonding-delegations "$CONTRACT" | jq '{unbonding_total: ([.unbonding_responses[]?.entries[]?.balance|tonumber] | add // 0)}'
