#!/usr/bin/env bash
# Jail report/purge drill (RC1 §9.8), proven 2026-07-09: stands up two extra
# validators that never sign, lets the chain downtime-jail them (~1 min at the
# dev genesis window of 100 blocks / 0.5 min-signed), then drives the full
# two-phase flow and asserts both purge paths:
#   - claimant redelegation (caller = eligible claimant's operator)
#   - pure unbond (any caller)
# plus the negative gates: report on an unjailed validator records nothing, a
# purge inside the cooldown is rejected, and a purge after the report clears
# needs a fresh report.
#
# Prereqs: fresh dev node (short unbonding, kv indexer) + nvhash-deploy-p2p.sh.
# The drill shortens jail_unbond_delay_secs to 30 for pacing.
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
DEPOSIT="${DEPOSIT:-500000000000}"
SELF_BOND="${SELF_BOND:-5000000000000}"   # 5% of genesis power each: chain keeps quorum
CRANK_FEES="${CRANK_FEES:-30000000000nhash}"
JAIL_DELAY="${JAIL_DELAY:-30}"

pexec() { docker exec "$CONTAINER" provenanced "$@"; }
qj()    { pexec query "$@" -t --home "$HOME_DIR" -o json; }
addr_of() { pexec keys show "$1" -a -t --home "$HOME_DIR" --keyring-backend test; }
valoper_of_key() { pexec keys show "$1" -a --bech val -t --home "$HOME_DIR" --keyring-backend test; }

TXFLAGS="-t --home ${HOME_DIR} --keyring-backend test --chain-id ${CHAIN_ID} --broadcast-mode sync -y -o json"

tx() { # tx <from> <gasargs...> -- <tx subcommand...>
  local from="$1"; shift
  local gas=()
  while [ "$1" != "--" ]; do gas+=("$1"); shift; done; shift
  local out txhash code res
  echo "+ tx $* (from $from)" >&2
  out="$(pexec tx "$@" $TXFLAGS "${gas[@]}" --from "$from" 2>/dev/null)"
  txhash="$(echo "$out" | jq -r '.txhash // empty')"
  [ -n "$txhash" ] || { echo "BROADCAST FAILED: $out" >&2; exit 1; }
  [ "$(echo "$out" | jq -r '.code')" = "0" ] || { echo "REJECTED: $(echo "$out" | jq -r '.raw_log')" >&2; exit 1; }
  for _ in $(seq 1 30); do
    res="$(pexec query tx "$txhash" -t --home "$HOME_DIR" -o json 2>/dev/null || true)"
    code="$(echo "$res" | jq -r '.code // empty' 2>/dev/null || true)"
    [ -n "$code" ] && break; sleep 1
  done
  [ "$code" = "0" ] || { echo "TX FAILED (code=${code:-?}): $(echo "$res" | jq -r '.raw_log // "?"' | head -c 400)" >&2; exit 1; }
  echo "$res"
}

# Broadcast expecting a delivery failure whose raw_log matches $1; fixed gas so
# the failure lands on-chain instead of dying in simulation.
tx_expect_fail() { # tx_expect_fail <pattern> <from> -- <tx subcommand...>
  local pattern="$1" from="$2"; shift 2; [ "$1" = "--" ] && shift
  local out txhash code res
  out="$(pexec tx "$@" $TXFLAGS --gas 3000000 --gas-prices 1nhash --from "$from" 2>/dev/null)"
  txhash="$(echo "$out" | jq -r '.txhash // empty')"
  [ -n "$txhash" ] || { echo "BROADCAST FAILED: $out" >&2; exit 1; }
  for _ in $(seq 1 30); do
    res="$(pexec query tx "$txhash" -t --home "$HOME_DIR" -o json 2>/dev/null || true)"
    code="$(echo "$res" | jq -r '.code // empty' 2>/dev/null || true)"
    [ -n "$code" ] && break; sleep 1
  done
  if [ "$code" = "0" ]; then echo "  FAIL expected failure matching '$pattern' but tx succeeded" >&2; exit 1; fi
  echo "$res" | jq -r '.raw_log' | grep -q "$pattern" \
    && echo "  OK   rejected as expected: $pattern" \
    || { echo "  FAIL wrong error: $(echo "$res" | jq -r '.raw_log' | head -c 300)" >&2; exit 1; }
}

assert_eq() { if [ "$2" = "$3" ]; then echo "  OK   $1 = $2"; else echo "  FAIL $1: got $2, want $3" >&2; exit 1; fi; }
assert_ge() { if [ "$(echo "$2 >= $3" | bc)" = "1" ]; then echo "  OK   $1 = $2 (>= $3)"; else echo "  FAIL $1: got $2, want >= $3" >&2; exit 1; fi; }

VAULT="$(qj vault list | jq -r --arg d "$SHARE" '.vaults[]?|select(.total_shares.denom==$d)|.base_account.address' | head -1)"
CONTRACT="$(qj vault get "$VAULT" | jq -r '.vault.asset_manager')"
[ -n "$CONTRACT" ] && [ "$CONTRACT" != "null" ] || { echo "no asset manager; run nvhash-deploy-p2p.sh" >&2; exit 1; }
smart() { qj wasm contract-state smart "$CONTRACT" "$1" 2>/dev/null | jq -r "$2"; }

del_of() { qj staking delegation "$CONTRACT" "$1" 2>/dev/null | jq -r '.delegation_response.balance.amount // "0"' || echo 0; }
unbonding_total() { qj staking unbonding-delegations "$CONTRACT" 2>/dev/null | jq -r '[.unbonding_responses[]?.entries[]?.balance|tonumber] | add // 0'; }
staked_total() { qj staking delegations "$CONTRACT" 2>/dev/null | jq -r '[.delegation_responses[]?.balance.amount|tonumber] | add // 0'; }
is_jailed() { qj staking validator "$1" 2>/dev/null | jq -r '.validator.jailed // false'; }

USER_ADDR="$(addr_of "$USER_ACCT")"
VAL1="$(valoper_of_key "$VALIDATOR")"
VAL2="$(valoper_of_key "$ADMIN")"
VAL3="$(valoper_of_key "$USER_ACCT")"
echo "contract=$CONTRACT val1=$VAL1 val2=$VAL2 val3=$VAL3"

echo; echo "== SETUP: config (30s cooldown), enrollment, two doomed validators =="
tx "$ADMIN" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
  wasm execute "$CONTRACT" "{\"update_config\":{\"jail_unbond_delay_secs\":$JAIL_DELAY,\"max_bonded_cap_bps\":30000,\"concentration_safety_offset_bps\":0}}" >/dev/null

make_validator() { # make_validator <key_name> <moniker>
  local key
  key="$(openssl rand -base64 32)"
  docker exec -i "$CONTAINER" sh -c "cat > /tmp/$2.json" <<JSON
{"pubkey":{"@type":"/cosmos.crypto.ed25519.PubKey","key":"$key"},"amount":"${SELF_BOND}${UNDERLYING}","moniker":"$2","commission-rate":"0.6","commission-max-rate":"0.6","commission-max-change-rate":"0.01","min-self-delegation":"1"}
JSON
  tx "$1" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
    staking create-validator "/tmp/$2.json" >/dev/null
}
make_validator "$ADMIN" drill-v2
make_validator "$USER_ACCT" drill-v3

for pair in "$VALIDATOR:$VAL1" "$ADMIN:$VAL2" "$USER_ACCT:$VAL3"; do
  key="${pair%%:*}"; vo="${pair#*:}"
  if smart '{"validators":{}}' ".data.validators[]|select(.valoper==\"$vo\")|.valoper" | grep -q .; then
    echo "  $vo already enrolled"
  else
    tx "$key" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
      wasm execute "$CONTRACT" "{\"register_participation\":{\"valoper\":\"$vo\"}}" >/dev/null
  fi
done

echo; echo "== NEGATIVE: reporting an unjailed validator records nothing =="
RES="$(tx "$ADMIN" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
  wasm execute "$CONTRACT" "{\"report_jailed_validator\":{\"valoper\":\"$VAL2\"}}")"
echo "$RES" | jq -e '.events[].attributes[]? | select(.key=="result" and .value=="not_jailed")' >/dev/null \
  && echo "  OK   report on unjailed validator: not_jailed, nothing recorded" \
  || { echo "  FAIL expected not_jailed result" >&2; exit 1; }
assert_eq "no reports on file" "$(smart '{"jail_reports":{}}' '.data.reports | length')" "0"

echo; echo "== DEPLOY: deposit + epoch spreads stake across all three =="
tx "$USER_ACCT" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
  vault swap-in "$USER_ADDR" "$VAULT" "${DEPOSIT}${UNDERLYING}" >/dev/null
tx "$ADMIN" --gas 4000000 --fees "$CRANK_FEES" -- \
  wasm execute "$CONTRACT" '{"run_epoch":{}}' >/dev/null
D1_0="$(del_of "$VAL1")"; D2_0="$(del_of "$VAL2")"; D3_0="$(del_of "$VAL3")"
echo "  delegations: v1=$D1_0 v2=$D2_0 v3=$D3_0"
assert_ge "v2 received stake" "$D2_0" "1"
assert_ge "v3 received stake" "$D3_0" "1"

echo; echo "== JAIL: waiting for the chain to downtime-jail v2 and v3 =="
DEADLINE=$(( $(date +%s) + 300 ))
until [ "$(is_jailed "$VAL2")" = "true" ] && [ "$(is_jailed "$VAL3")" = "true" ]; do
  [ "$(date +%s)" -lt "$DEADLINE" ] || { echo "validators not jailed in 300s" >&2; exit 1; }
  sleep 5
done
echo "  OK   v2 and v3 jailed on chain"
assert_eq "jailed validator assesses ineligible" \
  "$(smart '{"validators":{}}' ".data.validators[]|select(.valoper==\"$VAL2\")|.eligible")" "false"

# Invalid-signal fix (2026-07-09): a capture while v2/v3 are jailed/unbonded
# must record NOTHING for them (their frozen counters read a vacuous 100%),
# and the assessment must report no uptime signal rather than a confident one.
tx "$ADMIN" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
  wasm execute "$CONTRACT" '{"capture_uptime_signal":{}}' >/dev/null
assert_eq "capture skipped jailed v2 (no sample recorded)" \
  "$(smart '{"validators":{}}' ".data.validators[]|select(.valoper==\"$VAL2\")|.uptime_capture_count")" "0"
assert_eq "capture skipped jailed v3 (no sample recorded)" \
  "$(smart '{"validators":{}}' ".data.validators[]|select(.valoper==\"$VAL3\")|.uptime_capture_count")" "0"
assert_ge "capture still recorded the live v1" \
  "$(smart '{"validators":{}}' ".data.validators[]|select(.valoper==\"$VAL1\")|.uptime_capture_count")" "1"
assert_eq "jailed v2 reports no uptime signal" \
  "$(smart '{"validators":{}}' ".data.validators[]|select(.valoper==\"$VAL2\")|.uptime_bps")" "null"

echo; echo "== PHASE 1: report both =="
tx "$USER_ACCT" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
  wasm execute "$CONTRACT" "{\"report_jailed_validator\":{\"valoper\":\"$VAL2\"}}" >/dev/null
tx "$ADMIN" --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- \
  wasm execute "$CONTRACT" "{\"report_jailed_validator\":{\"valoper\":\"$VAL3\"}}" >/dev/null
assert_eq "two reports on file" "$(smart '{"jail_reports":{}}' '.data.reports | length')" "2"

# Observation hook (app M8.1 jail lane): with reports on file and the first
# purge not yet run, an optional caller-supplied command observes the app's
# surfaces against this live jail state (the only point where a real jailed
# validator with an open report exists). Script-side and additive only — the
# contract drill itself stays canonical, and an unset hook changes nothing.
if [ -n "${JAIL_OBSERVE_CMD:-}" ]; then
  echo; echo "== OBSERVE: running JAIL_OBSERVE_CMD against the live jail state =="
  E2E_JAIL_VALOPER="$VAL2" $JAIL_OBSERVE_CMD
fi

echo; echo "== NEGATIVE: purge inside the cooldown is rejected =="
tx_expect_fail "cooldown" "$ADMIN" -- \
  wasm execute "$CONTRACT" "{\"purge_jailed_validator\":{\"valoper\":\"$VAL2\"}}"

echo "  waiting out the ${JAIL_DELAY}s cooldown..."
# Block time tracks wall time on a live devnet; wait a couple seconds past
# purge_ready to be safe.
READY="$(smart '{"jail_reports":{}}' ".data.reports[]|select(.valoper==\"$VAL2\")|.purge_ready_at_seconds")"
until [ "$(date +%s)" -gt "$((READY + 2))" ]; do sleep 3; done

echo; echo "== PHASE 2a: claimant redelegation (caller = claimant's operator) =="
# The dev chain slashes 1% on downtime jail (SDK default slash_fraction), so
# the live delegation at purge time is BELOW the deployed amount. The purge
# moves whatever actually remains; the slash surfaces later as a write-down.
G0="$(del_of "$VAL1")"
D2_LIVE="$(del_of "$VAL2")"
RES="$(tx "$VALIDATOR" --gas 4000000 --gas-prices 1nhash -- \
  wasm execute "$CONTRACT" "{\"purge_jailed_validator\":{\"valoper\":\"$VAL2\",\"claimant_valoper\":\"$VAL1\"}}")"
echo "$RES" | jq -r '.events[].attributes[]? | select(.key=="redelegated" or .key=="unbonded" or .key=="deferred") | "  \(.key)=\(.value)"' | sort -u
assert_eq "v2 fully purged" "$(del_of "$VAL2")" "0"
G1="$(del_of "$VAL1")"
# Staking share <-> token conversion floors, so the destination may land a few
# units below the redelegated amount.
EXPECT="$(echo "$G0 + $D2_LIVE" | bc)"
DIFF="$(echo "$EXPECT - $G1" | bc)"
assert_ge "claimant received the live delegation (floor dust $DIFF <= 2)" "2" "$DIFF"
assert_ge "claimant delegation grew" "$G1" "$G0"
echo "  slash observed on v2: $(echo "$D2_0 - $D2_LIVE" | bc) (deployed $D2_0, live $D2_LIVE)"
assert_eq "v2 report cleared after full purge" \
  "$(smart '{"jail_reports":{}}' ".data.reports[]|select(.valoper==\"$VAL2\")|.valoper" | grep -c . || true)" "0"

echo; echo "== PHASE 2b: pure unbond (any caller, no claimant) =="
U0="$(unbonding_total)"
D3_LIVE="$(del_of "$VAL3")"
tx "$ADMIN" --gas 4000000 --gas-prices 1nhash -- \
  wasm execute "$CONTRACT" "{\"purge_jailed_validator\":{\"valoper\":\"$VAL3\"}}" >/dev/null
assert_eq "v3 fully purged" "$(del_of "$VAL3")" "0"
U1="$(unbonding_total)"
UDIFF="$(echo "$D3_LIVE - ($U1 - $U0)" | bc)"
assert_ge "live delegation unbonding (floor dust $UDIFF <= 2)" "2" "$UDIFF"
assert_eq "no reports left" "$(smart '{"jail_reports":{}}' '.data.reports | length')" "0"

echo; echo "== NEGATIVE: purge after clear needs a fresh report =="
tx_expect_fail "no jail report" "$ADMIN" -- \
  wasm execute "$CONTRACT" "{\"purge_jailed_validator\":{\"valoper\":\"$VAL3\"}}"

echo; echo "== PHASE 3: slash recognition (write-down leg, v1.2 D5) =="
# The 1% downtime slashes left receipt outstanding above what is actually out
# on chain: the very gap plan_return recognizes as matured-and-unbacked. The
# next epoch settles what returned liquid covers and WRITES DOWN the rest via
# the paused WithdrawPrincipalFunds(receipt) + burn: TVV marks down THIS epoch,
# never deferred. This exercises the final unverified settlement-path leg.
rm_now() { smart '{"epoch_status":{}}' '.data.receipt_minted' | tr -d '"'; }
out_now() {
  local pend
  pend="$(smart '{"epoch_status":{}}' '[.data.pending_delegations[]?.amount|tonumber] | add // 0')"
  echo $(( $(staked_total) + $(unbonding_total) + pend ))
}
RM0="$(rm_now)"; OUT0="$(out_now)"
GAP=$(( RM0 - OUT0 ))
assert_ge "slash gap detected (receipt above backing)" "$GAP" "1"
LIQ="$(qj bank balances "$CONTRACT" 2>/dev/null | jq -r --arg d "$UNDERLYING" '.balances[]? | select(.denom==$d) | .amount // "0"')"
LIQ="${LIQ:-0}"
TVV0="$(qj vault get "$VAULT" | jq -r '.total_vault_value.amount')"
RES="$(tx "$ADMIN" --gas 4000000 --fees "$CRANK_FEES" -- \
  wasm execute "$CONTRACT" '{"run_epoch":{}}')"
echo "$RES" | jq -r '[.events[].type] | map(select(test("NAVUpdated|PaymentAccepted|MarkerBurn|Paused|Unpaused"))) | unique[]' | sed 's/^/  event: /'
WRITE_DOWN=$(( GAP > LIQ ? GAP - LIQ : 0 ))
if [ "$WRITE_DOWN" -gt 0 ]; then
  # The guardrail sandwich: NAV marked to zero for the unbacked units, a
  # zero-priced settlement extracts them, the 1:1 entry is restored.
  echo "$RES" | jq -e '[.events[].type] | any(test("NAVUpdated"))' >/dev/null \
    && echo "  OK   NAV sandwich executed (mark, extract, restore)" \
    || { echo "  FAIL write-down expected but no NAVUpdated event" >&2; exit 1; }
  FINAL_NAV="$(qj vault navs "$VAULT" 2>/dev/null | jq -c "[.navs[]?|select(.denom==\"$RECEIPT_DENOM\")|{price: .price.amount, volume: .volume}]")"
  echo "  receipt NAV after sandwich: $FINAL_NAV"
fi
TVV1="$(qj vault get "$VAULT" | jq -r '.total_vault_value.amount')"
echo "  gap=$GAP liquid_settled=$LIQ write_down=$WRITE_DOWN tvv: $TVV0 -> $TVV1"
assert_ge "TVV marked down by at least the write-down" "$(echo "$TVV0 - $TVV1" | bc)" "$WRITE_DOWN"
assert_eq "vault unpaused" "$(qj vault get "$VAULT" | jq -r '.vault.paused // false')" "false"

echo; echo "== INVARIANT: receipt again backs staked + unbonding + pending =="
# The crank settled + wrote down the whole gap and re-minted only what it
# redeployed, so the counter, the bank supply, and the on-chain backing all
# agree again: loss recognition was not deferred.
RM1="$(rm_now)"; OUT1="$(out_now)"
SUP1="$(qj bank total-supply-of "$RECEIPT_DENOM" 2>/dev/null | jq -r '.amount.amount')"
assert_eq "receipt_minted == staked + unbonding + pending" "$RM1" "$OUT1"
assert_eq "receipt_minted == receipt supply" "$RM1" "$SUP1"

echo; echo "== SNAPSHOT: the write-down and purges are in the epoch analytics =="
SNAP="$(qj wasm contract-state smart "$CONTRACT" '{"epoch_snapshot":{}}' | jq '.data.snapshot')"
assert_eq "snapshot write_down == recognized loss" "$(echo "$SNAP" | jq -r '.write_down')" "$WRITE_DOWN"
assert_eq "snapshot validators_purged" "$(echo "$SNAP" | jq -r '.validators_purged')" "2"
assert_eq "snapshot settled == liquid consumed" "$(echo "$SNAP" | jq -r '.settled')" "$LIQ"

# Observation hook, teardown leg (app M8.1 jail lane): with every report
# purged or cleared, the app-side jail_report incidents must have CLOSED.
if [ -n "${JAIL_OBSERVE_CMD:-}" ]; then
  echo; echo "== OBSERVE: teardown — jail incidents closed after the purges =="
  E2E_JAIL_VALOPER="$VAL2" E2E_JAIL_EXPECT=closed $JAIL_OBSERVE_CMD
fi

echo; echo "== JAIL DRILL PASSED (incl. slash write-down) =="
