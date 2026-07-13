#!/usr/bin/env bash
# Design C settlement drill: the repeatable integration harness proven on
# 2026-07-08 against a provenance dev node built with ProvLabs/vault main
# (AcceptAsset era). Drives the full money path and asserts the v1.2 §4.2
# invariants against live chain state after each phase.
#
# Prereqs:
#   - dev node running with a vault-main provenance build (see IMPLEMENTATION-
#     STATUS.md §6 and the provenance repo: make devnet-start), tx indexer "kv",
#     and a SHORT staking unbonding_time (the drill waits for real maturities;
#     120s recommended: patch app_state.staking.params.unbonding_time in genesis)
#   - scripts/nvhash-deploy-p2p.sh completed (marker, vault, NAV seed, contract)
#
# Phases:
#   1 enroll     validator registers; live eligibility asserted
#   2 deposit    user swap-in; share scalar asserted
#   3 deploy     RunEpoch: mint -> payment -> AcceptAsset -> delegate;
#                receipt-in-marker + TVV-neutrality + four-way invariant
#   4 rewards    ClaimRewards then RunEpoch: NAV step-up == claimed rewards
#   5 redeem     swap-out; ServiceRedemptions unbonds increment (+margin)
#   6 settle     after maturity RunEpoch: return settlement + transfer + BURN;
#                four-way invariant re-asserted at the lower level
#   7 expedite   second swap-out covered by marker liquidity pays immediately
set -euo pipefail

CONTAINER="${CONTAINER:-dev-node}"
CHAIN_ID="${CHAIN_ID:-chain-dev}"
HOME_DIR="${HOME_DIR:-/provenance/nodedev}"
ADMIN="${ADMIN:-account-1}"
USER_ACCT="${USER_ACCT:-account-2}"
VALIDATOR="${VALIDATOR:-validator}"
SHARE="${SHARE:-nvhash}"
UNDERLYING="${UNDERLYING:-nhash}"
RECEIPT_DENOM="${RECEIPT_DENOM:-nvhash.staked}"
DEPOSIT="${DEPOSIT:-500000000000}"            # 500 HASH
REDEEM_SHARES="${REDEEM_SHARES:-100000000000000000}"   # 100 HASH face
EXPEDITE_SHARES="${EXPEDITE_SHARES:-90000000000000000}" # fits marker liquidity
# Exchange flat fees (create 10 + accept 8 HASH by default) are assessed on the
# crank caller's tx, so cranks attach a flat fee instead of gas-priced fees.
CRANK_FEES="${CRANK_FEES:-30000000000nhash}"

pexec() { docker exec "$CONTAINER" provenanced "$@"; }
qj()    { pexec query "$@" -t --home "$HOME_DIR" -o json; }
addr_of() { pexec keys show "$1" -a -t --home "$HOME_DIR" --keyring-backend test; }

TXFLAGS="-t --home ${HOME_DIR} --keyring-backend test --chain-id ${CHAIN_ID} --broadcast-mode sync -y -o json"

tx() { # tx <from> <gasargs...> -- <tx subcommand...>
  local from="$1"; shift
  local gas=()
  while [ "$1" != "--" ]; do gas+=("$1"); shift; done; shift
  local out txhash code res i
  echo "+ tx $* (from $from)" >&2
  out="$(pexec tx "$@" $TXFLAGS "${gas[@]}" --from "$from" 2>/dev/null)"
  txhash="$(echo "$out" | jq -r '.txhash // empty')"
  [ -n "$txhash" ] || { echo "BROADCAST FAILED: $out" >&2; exit 1; }
  [ "$(echo "$out" | jq -r '.code')" = "0" ] || { echo "REJECTED: $(echo "$out" | jq -r '.raw_log')" >&2; exit 1; }
  for i in $(seq 1 30); do
    res="$(pexec query tx "$txhash" -t --home "$HOME_DIR" -o json 2>/dev/null || true)"
    code="$(echo "$res" | jq -r '.code // empty' 2>/dev/null || true)"
    [ -n "$code" ] && break; sleep 1
  done
  [ "$code" = "0" ] || { echo "TX FAILED (code=${code:-?}): $(echo "$res" | jq -r '.raw_log // "?"' | head -c 400)" >&2; exit 1; }
  echo "$res"
}

assert_eq() { # assert_eq <label> <got> <want>
  if [ "$2" = "$3" ]; then echo "  OK   $1 = $2"
  else echo "  FAIL $1: got $2, want $3" >&2; exit 1; fi
}
assert_ge() {
  if [ "$(echo "$2 >= $3" | bc)" = "1" ]; then echo "  OK   $1 = $2 (>= $3)"
  else echo "  FAIL $1: got $2, want >= $3" >&2; exit 1; fi
}

bal() { qj bank balances "$1" 2>/dev/null | jq -r --arg d "$2" '.balances[]? | select(.denom==$d) | .amount // "0"' ; }
bal0() { local b; b="$(bal "$1" "$2")"; echo "${b:-0}"; }

ADMIN_ADDR="$(addr_of "$ADMIN")"
USER_ADDR="$(addr_of "$USER_ACCT")"
VALOPER="$(pexec keys show "$VALIDATOR" -a --bech val -t --home "$HOME_DIR" --keyring-backend test)"
VAULT="$(qj vault list | jq -r --arg d "$SHARE" '.vaults[]?|select(.total_shares.denom==$d)|.base_account.address' | head -1)"
PRINCIPAL="$(qj vault get "$VAULT" | jq -r '.principal.address')"
CONTRACT="$(qj vault get "$VAULT" | jq -r '.vault.asset_manager')"
[ -n "$CONTRACT" ] && [ "$CONTRACT" != "null" ] || { echo "no asset manager; run nvhash-deploy-p2p.sh" >&2; exit 1; }
smart() { qj wasm contract-state smart "$CONTRACT" "$1" 2>/dev/null | jq -c "$2"; }

tvv() { qj vault get "$VAULT" | jq -r '.total_vault_value.amount'; }
receipt_supply() { qj bank total-supply-of "$RECEIPT_DENOM" | jq -r '.amount.amount'; }
staked_total() { qj staking delegations "$CONTRACT" 2>/dev/null | jq -r '[.delegation_responses[]?.balance.amount|tonumber] | add // 0'; }
receipt_minted() { smart '{"epoch_status":{}}' '.data.receipt_minted' | tr -d '"'; }
unbonding_total() { qj staking unbonding-delegations "$CONTRACT" 2>/dev/null | jq -r '[.unbonding_responses[]?.entries[]?.balance|tonumber] | add // 0'; }

# The four-way receipt invariant (v1.2 §4.2 item 1):
# RECEIPT_MINTED == receipt supply == receipt held by principal marker ==
# nhash out (staked + unbonding + withdrawn-not-yet-delegated).
assert_receipt_invariant() {
  local rm supply held out pend
  rm="$(receipt_minted)"; supply="$(receipt_supply)"; held="$(bal0 "$PRINCIPAL" "$RECEIPT_DENOM")"
  pend="$(smart '{"epoch_status":{}}' '[.data.pending_delegations[]?.amount|tonumber] | add // 0')"
  out=$(( $(staked_total) + $(unbonding_total) + pend ))
  assert_eq "receipt_minted == receipt supply" "$rm" "$supply"
  assert_eq "receipt supply == principal holdings" "$supply" "$held"
  assert_eq "receipt_minted == nhash out (staked+unbonding+pending)" "$rm" "$out"
}

echo "vault=$VAULT principal=$PRINCIPAL contract=$CONTRACT valoper=$VALOPER"

echo; echo "== PHASE 1: enroll =="
if smart '{"validators":{}}' '.data.validators | length' | grep -qv '^0$'; then
  echo "  already enrolled"
else
  tx "$VALIDATOR" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
    wasm execute "$CONTRACT" "{\"register_participation\":{\"valoper\":\"$VALOPER\"}}" >/dev/null
fi
ELIG="$(smart '{"validators":{}}' '.data.validators[0].eligible')"
assert_eq "validator eligible" "$ELIG" "true"
# Single/dual-validator devnets: the chain's concentration hook is inactive
# below 4 active validators, so widen the contract's cap mirrors for the drill.
HEADROOM="$(smart '{"validators":{}}' '.data.validators[0].headroom' | tr -d '"')"
if [ "$HEADROOM" = "0" ]; then
  echo "  widening cap mirrors for a small devnet validator set"
  tx "$ADMIN" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
    wasm execute "$CONTRACT" '{"update_config":{"max_bonded_cap_bps":30000,"concentration_safety_offset_bps":0}}' >/dev/null
fi

echo; echo "== PHASE 2: deposit =="
tx "$USER_ACCT" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
  vault swap-in "$USER_ADDR" "$VAULT" "${DEPOSIT}${UNDERLYING}" >/dev/null
SHARES="$(bal0 "$USER_ADDR" "$SHARE")"
assert_ge "shares minted (1e6 scalar)" "$SHARES" "$(echo "$DEPOSIT * 1000000" | bc)"

echo; echo "== PHASE 3: deploy settlement =="
TVV0="$(tvv)"
# Contract-held liquid (reward dust from prior cranks) is deposited into
# principal by this crank as rewards_dep: a legitimate NAV step, not a
# neutrality violation. Net it out of the drift tolerance.
CB0="$(bal0 "$CONTRACT" "$UNDERLYING")"
tx "$ADMIN" --gas 4000000 --fees "$CRANK_FEES" -- \
  wasm execute "$CONTRACT" '{"run_epoch":{}}' >/dev/null
assert_receipt_invariant
TVV1="$(tvv)"
# Value neutrality of the SETTLEMENT: TVV may move only by the reward deposit
# (CB0) plus AUM accrual + valuation floor dust.
DRIFT=$(( TVV0 > TVV1 ? TVV0 - TVV1 : TVV1 - TVV0 ))
TOL=$(( CB0 + 100000 ))
assert_ge "TVV neutrality (drift $DRIFT <= reward dust $CB0 + 100000)" "$TOL" "$DRIFT"
assert_eq "vault unpaused" "$(qj vault get "$VAULT" | jq -r '.vault.paused // false')" "false"

echo; echo "== PHASE 4: rewards -> NAV step; commission accrual + tip rollover =="
sleep 8
# A TIP paid mid-epoch (any payer) counts toward the upcoming plan and resets
# at the epoch completion below (RC1 §10.2).
tx "$ADMIN" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
  wasm execute "$CONTRACT" "{\"pay_tip\":{\"valoper\":\"$VALOPER\"}}" --amount "1000000${UNDERLYING}" >/dev/null
TIP="$(smart '{"validators":{}}' '.data.validators[0].tip_epoch' | tr -d '"')"
assert_eq "tip credited" "$TIP" "1000000"

tx "$ADMIN" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
  wasm execute "$CONTRACT" '{"claim_rewards":{}}' >/dev/null
CLAIMED="$(bal0 "$CONTRACT" "$UNDERLYING")"
assert_ge "rewards claimed (incl. tip held)" "$CLAIMED" "1"
ACCRUED0="$(smart '{"validators":{}}' '.data.validators[0].commission_accrued' | tr -d '"')"
assert_ge "commission accrued on claimed rewards" "$ACCRUED0" "1"

TVV0="$(tvv)"
tx "$ADMIN" --gas 4000000 --fees "$CRANK_FEES" -- \
  wasm execute "$CONTRACT" '{"run_epoch":{}}' >/dev/null
TVV1="$(tvv)"
# The deposit leg sweeps rewards AND the held tip into principal.
assert_ge "TVV stepped up by ~rewards+tip" "$((TVV1 - TVV0))" "$((CLAIMED * 9 / 10))"
TIP="$(smart '{"validators":{}}' '.data.validators[0].tip_epoch' | tr -d '"')"
assert_eq "tip reset at epoch rollover" "$TIP" "0"
assert_receipt_invariant

# §9.10 snapshot and APR: the crank recorded the window's decomposition.
SNAP="$(qj wasm contract-state smart "$CONTRACT" '{"epoch_snapshot":{}}' | jq '.data.snapshot')"
assert_eq "snapshot tips_received" "$(echo "$SNAP" | jq -r '.tips_received')" "1000000"
assert_eq "snapshot rewards_deposited == swept liquid" "$(echo "$SNAP" | jq -r '.rewards_deposited')" "$CLAIMED"
SNAP_CLAIMED="$(echo "$SNAP" | jq -r '.rewards_claimed')"
assert_ge "snapshot rewards_claimed covers the endpoint claim" "$SNAP_CLAIMED" "$(echo "$CLAIMED - 1000000" | bc)"
T_BEFORE="$(echo "$SNAP" | jq -r '.tvv_before')"; T_AFTER="$(echo "$SNAP" | jq -r '.tvv_after')"
assert_eq "snapshot identity tvv_after == tvv_before + deposited" "$T_AFTER" "$(echo "$T_BEFORE + $CLAIMED" | bc)"
APR="$(qj wasm contract-state smart "$CONTRACT" '{"apr":{}}' | jq '.data')"
GROSS="$(echo "$APR" | jq -r '.gross_apr_bps')"; NET="$(echo "$APR" | jq -r '.net_apr_bps')"
assert_ge "gross apr positive" "$GROSS" "1"
assert_ge "net apr <= gross" "$GROSS" "$NET"
echo "  apr window=$(echo "$APR" | jq -r '.window_seconds')s gross=${GROSS}bps net=${NET}bps"

echo; echo "== PHASE 5: redeem -> unbond =="
tx "$USER_ACCT" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
  vault swap-out "$USER_ADDR" "$VAULT" "${REDEEM_SHARES}${SHARE}" >/dev/null
tx "$ADMIN" --gas 4000000 --gas-prices 1nhash -- \
  wasm execute "$CONTRACT" '{"service_redemptions":{}}' >/dev/null
UNB="$(unbonding_total)"
assert_ge "unbond initiated (estimate + margin)" "$UNB" "1"
echo "  unbonding: $UNB"

# Wait until the contract's liquid balance reaches at least `1` (a target
# amount): the 2026-07-08 drill fired early on reward dust and settled nothing,
# so maturity waits must target the full unbonded amount.
wait_for_liquid() { # wait_for_liquid <min_amount> <deadline_secs>
  local deadline=$(( $(date +%s) + $2 ))
  while :; do
    local b; b="$(bal0 "$CONTRACT" "$UNDERLYING")"
    [ "$(echo "$b >= $1" | bc)" = "1" ] && return 0
    [ "$(date +%s)" -lt "$deadline" ] || { echo "unbond did not mature in ${2}s" >&2; exit 1; }
    sleep 3
  done
}

# Wait for the payout EndBlocker to move the user's balance past a floor.
wait_for_payout() { # wait_for_payout <addr> <min_delta> <baseline> <deadline_secs>
  local deadline=$(( $(date +%s) + $4 ))
  while :; do
    local b; b="$(bal0 "$1" "$UNDERLYING")"
    [ "$(echo "$b - $3 >= $2" | bc)" = "1" ] && { echo "$((b - $3))"; return 0; }
    [ "$(date +%s)" -lt "$deadline" ] || { echo "payout did not land in ${4}s" >&2; exit 1; }
    sleep 2
  done
}

echo; echo "== PHASE 6: maturity -> settle + burn -> redemption paid =="
NHASH0="$(bal0 "$USER_ADDR" "$UNDERLYING")"
wait_for_liquid "$UNB" 300
SUP0="$(receipt_supply)"
RES="$(tx "$ADMIN" --gas 4000000 --fees "$CRANK_FEES" -- \
  wasm execute "$CONTRACT" '{"run_epoch":{}}')"
echo "$RES" | jq -r '[.events[].type] | map(select(test("PaymentAccepted|MarkerBurn|MarkerTransfer|Expedited"))) | unique[]' | sed 's/^/  event: /'
SUP1="$(receipt_supply)"
assert_ge "receipt burned (supply dropped)" "$((SUP0 - SUP1))" "1"
assert_receipt_invariant
# The same crank's D2 expedites the now-funded redemption; the EndBlocker pays.
PAID="$(wait_for_payout "$USER_ADDR" "$(echo "$REDEEM_SHARES / 1000000 * 99 / 100" | bc)" "$NHASH0" 200)"
echo "  OK   redemption paid: $PAID $UNDERLYING"
assert_eq "queue empty" "$(qj vault vault-pending-swap-outs "$VAULT" | jq -r '.pending_swap_outs | length')" "0"
# NOTE: if this crank had missed the 180s timeout, the vault refunds the
# escrowed shares and cancels the redemption (observed 2026-07-08; no
# auto-pause). A refund here means the operator was too slow, not a bug.

echo; echo "== PHASE 7: second cycle, expedite before timeout =="
NHASH0="$(bal0 "$USER_ADDR" "$UNDERLYING")"
tx "$USER_ACCT" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
  vault swap-out "$USER_ADDR" "$VAULT" "${EXPEDITE_SHARES}${SHARE}" >/dev/null
tx "$ADMIN" --gas 4000000 --gas-prices 1nhash -- \
  wasm execute "$CONTRACT" '{"service_redemptions":{}}' >/dev/null
UNB="$(unbonding_total)"
wait_for_liquid "$UNB" 300
RES="$(tx "$ADMIN" --gas 4000000 --fees "$CRANK_FEES" -- \
  wasm execute "$CONTRACT" '{"run_epoch":{}}')"
echo "$RES" | jq -e '[.events[].type] | any(test("Expedited"))' >/dev/null \
  && echo "  OK   expedite event emitted (paid before the withdrawal delay)" \
  || { echo "  FAIL no expedite event" >&2; exit 1; }
PAID="$(wait_for_payout "$USER_ADDR" "$(echo "$EXPEDITE_SHARES / 1000000 * 99 / 100" | bc)" "$NHASH0" 200)"
echo "  OK   expedited payout: $PAID $UNDERLYING"
assert_eq "queue empty" "$(qj vault vault-pending-swap-outs "$VAULT" | jq -r '.pending_swap_outs | length')" "0"
assert_receipt_invariant

echo; echo "== PHASE 8: commission grace -> arrears -> pay -> restored =="
# Two epoch completions have passed since phase 4 accrued commission (phases 6
# and 7 each completed one), so the unpaid accrual is past its one-epoch grace:
# the validator must assess in arrears and ineligible (RC1 §10.1).
IN_ARREARS="$(smart '{"validators":{}}' '.data.validators[0].in_arrears')"
ELIGIBLE="$(smart '{"validators":{}}' '.data.validators[0].eligible')"
assert_eq "in arrears past the grace epoch" "$IN_ARREARS" "true"
assert_eq "arrears alone disqualifies" "$ELIGIBLE" "false"
# Bringing the account current (any payer) restores eligibility at the next
# plan, live: pay the full accrual to date.
OWED="$(smart '{"validators":{}}' '.data.validators[0].commission_accrued' | tr -d '"')"
tx "$ADMIN" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
  wasm execute "$CONTRACT" "{\"pay_commission\":{\"valoper\":\"$VALOPER\"}}" --amount "${OWED}${UNDERLYING}" >/dev/null
IN_ARREARS="$(smart '{"validators":{}}' '.data.validators[0].in_arrears')"
ELIGIBLE="$(smart '{"validators":{}}' '.data.validators[0].eligible')"
assert_eq "arrears cleared by payment" "$IN_ARREARS" "false"
assert_eq "eligibility restored live" "$ELIGIBLE" "true"

echo; echo "== PHASE 9: uniform-slot rebalance (RC1 §9.2/§9.3/§9.4) =="
del_of() { qj staking delegation "$CONTRACT" "$1" 2>/dev/null | jq -r '.delegation_response.balance.amount // "0"' || echo 0; }
U_BEFORE="$(unbonding_total)"

# Stand up a second validator (operator = admin account) and enroll it. Its
# synthetic consensus key never signs, so keep this phase brisk: the chain
# downtime-jails it roughly a minute after creation.
KEY="$(openssl rand -base64 32)"
docker exec -i "$CONTAINER" sh -c "cat > /tmp/drill-rb.json" <<JSON
{"pubkey":{"@type":"/cosmos.crypto.ed25519.PubKey","key":"$KEY"},"amount":"5000000000000${UNDERLYING}","moniker":"drill-rb","commission-rate":"0.6","commission-max-rate":"0.6","commission-max-change-rate":"0.01","min-self-delegation":"1"}
JSON
ADMIN_ADDR="$(addr_of "$ADMIN")"
VAL2="$(pexec keys show "$ADMIN" -a --bech val -t --home "$HOME_DIR" --keyring-backend test)"
tx "$ADMIN" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
  staking create-validator /tmp/drill-rb.json >/dev/null
tx "$ADMIN" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
  wasm execute "$CONTRACT" "{\"register_participation\":{\"valoper\":\"$VAL2\"}}" >/dev/null

# Epoch: the engine levels both seats to the same slot by REDELEGATING half
# of v1's stake to v2 (plus any fresh surplus). No unbonding involved.
tx "$ADMIN" --gas 4000000 --fees "$CRANK_FEES" -- \
  wasm execute "$CONTRACT" '{"run_epoch":{}}' >/dev/null
D1="$(del_of "$VALOPER")"; D2="$(del_of "$VAL2")"
DIFF=$(( D1 > D2 ? D1 - D2 : D2 - D1 ))
echo "  post-rebalance delegations: v1=$D1 v2=$D2"
assert_ge "uniform slot reached (|d1 - d2| = $DIFF <= 10)" "10" "$DIFF"
REB="$(qj wasm contract-state smart "$CONTRACT" '{"epoch_snapshot":{}}' | jq -r '.data.snapshot.rebalanced')"
assert_ge "snapshot recorded the rebalance" "$REB" "1"
assert_receipt_invariant

# Keep v1 current on commission for the rest of the phase: the drill's
# back-to-back epochs shrink the one-epoch grace to seconds, and an in-arrears
# v1 would leave the rebalance with zero eligible destinations (the engine
# correctly refuses to redirect stake toward a non-compliant validator).
OWED="$(smart '{"validators":{}}' ".data.validators[]|select(.valoper==\"$VALOPER\")|.commission_accrued" | tr -d '"')"
tx "$ADMIN" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
  wasm execute "$CONTRACT" "{\"pay_commission\":{\"valoper\":\"$VALOPER\"}}" --amount "$((OWED + 5000000000))${UNDERLYING}" >/dev/null

# Unregister v2. An epoch run IMMEDIATELY still cannot move its stake: v2
# received a redelegation inside the unbonding period, and the
# no-transitive-redelegation rule forbids sourcing from it. The engine must
# DEFER (crank succeeds, stake stays) rather than emit a reverting move. On
# mainnet the monthly cadence always outlives the lock (RC1 §9.3); this drill
# waits it out explicitly.
tx "$ADMIN" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
  wasm execute "$CONTRACT" "{\"unregister_participation\":{\"valoper\":\"$VAL2\"}}" >/dev/null
tx "$ADMIN" --gas 4000000 --fees "$CRANK_FEES" -- \
  wasm execute "$CONTRACT" '{"run_epoch":{}}' >/dev/null
assert_ge "transitivity guard deferred the drain (crank still succeeded)" \
  "$(del_of "$VAL2")" "1"
echo "  waiting out the redelegation lock (unbonding period)..."
sleep 130

# With the lock expired the next epoch redirects v2's stake back to v1 via
# redelegation (§9.4: never crash-unbonded). By now v2 has been downtime
# jailed and 1%-slashed (it never signs), so the same crank also recognizes
# the slash write-down; unbonding stays untouched throughout.
tx "$ADMIN" --gas 4000000 --fees "$CRANK_FEES" -- \
  wasm execute "$CONTRACT" '{"run_epoch":{}}' >/dev/null
assert_eq "unregistered validator fully drained" "$(del_of "$VAL2")" "0"
assert_ge "stake returned to v1" "$(del_of "$VALOPER")" "$D1"
U_AFTER="$(unbonding_total)"
assert_eq "no unbonding used by any rebalance move" "$U_AFTER" "$U_BEFORE"
assert_receipt_invariant

echo; echo "== DRILL PASSED =="
echo "  slash write-down + jail report/purge are covered separately by"
echo "  scripts/jail-drill.sh (needs real downtime jailing)."
