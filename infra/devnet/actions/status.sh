#!/usr/bin/env bash
# One-stop dev-node status: engine state, validators, analytics, queue, vault.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
resolve
echo "vault:    $VAULT"
echo "contract: $CONTRACT"
echo; echo "== epoch status =="
smart '{"epoch_status":{}}'
echo; echo "== validators (priority order) =="
smart '{"validators":{}}' '[.data.validators[] | {valoper, eligible, in_arrears, jailed, uptime_bps: (.uptime_bps // "n/a (no signal)"), tip_epoch, headroom}]'
echo; echo "== last epoch snapshot =="
smart '{"epoch_snapshot":{}}'
echo; echo "== apr =="
smart '{"apr":{}}'
echo; echo "== jail reports =="
smart '{"jail_reports":{}}' '.data.reports'
echo; echo "== pending swap-outs =="
qj vault vault-pending-swap-outs "$VAULT" | jq '.pending_swap_outs'
echo; echo "== vault =="
qj vault get "$VAULT" | jq '{tvv: .total_vault_value, shares: .vault.total_shares, paused: (.vault.paused // false), principal: .principal.coins}'
echo; echo "== contract delegations =="
qj staking delegations "$CONTRACT" | jq '[.delegation_responses[]? | {val: .delegation.validator_address, amount: .balance.amount}]'
