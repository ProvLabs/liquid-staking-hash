#!/usr/bin/env bash
# Calendar-month cadence drill (milestone E-CAL): proves the RunEpoch
# eligibility predicate is live on a real Provenance dev node — an eligible
# crank runs a full epoch end-to-end, and a premature second crank in the SAME
# calendar month is rejected with `too soon`. The boundary is
# `civil_month(block_time) > civil_month(last_run)` (liquid-staking-spec §9),
# derived entirely from consensus block time.
#
# Scope note (why no boundary crossing here): on a single-node CometBFT devnet
# `block.time` tracks the container's real wall clock — `genesis_time` only
# stamps block 1, and there is no libfaketime in the dev image — so the chain
# cannot be made to cross a calendar boundary in seconds. The cross-boundary
# "aligned next epoch" is instead covered deterministically by the embedded-
# chain test (`app.increase_time`, `src/tests.rs`) and the simulation. This
# drill proves the unique thing only a live chain can: the predicate is deployed
# and enforcing.
#
# Same-month lock: once an epoch has cranked in the current calendar month the
# contract is month-locked until the next rollover — this is the cadence working
# as designed, not a fault. So run this against a FRESH bootstrap (last_run is
# the 1970 epoch default); re-running within the same calendar month exercises
# only the rejection path (the drill detects this and says so).
#
# Prereqs:
#   - dev node running (infra/devnet/dev-node.sh up)
#   - infra/devnet/bootstrap/nvhash-deploy-p2p.sh completed (vault + contract)
#
# Phases:
#   1 eligible   an eligible RunEpoch runs to completion (phase Idle, a §9.10
#                snapshot is recorded, last_run advances into the current month)
#   2 rejected   an immediate second RunEpoch in the same month is rejected
#                with `too soon`, and the reported next-eligible instant lands
#                in a strictly later calendar month
set -euo pipefail

CONTAINER="${CONTAINER:-dev-node}"
CHAIN_ID="${CHAIN_ID:-chain-dev}"
HOME_DIR="${HOME_DIR:-/provenance/nodedev}"
ADMIN="${ADMIN:-account-1}"
SHARE="${SHARE:-nvhash}"
UNDERLYING="${UNDERLYING:-nhash}"
# Exchange flat fees (create 10 + accept 8 HASH by default) are assessed on the
# crank caller's tx when a crank settles; attach them so a stocked first crank
# is not fee-starved (harmless on an empty crank).
CRANK_FEES="${CRANK_FEES:-30000000000nhash}"

pexec() { docker exec "$CONTAINER" provenanced "$@"; }
qj()    { pexec query "$@" -t --home "$HOME_DIR" -o json; }

TXFLAGS="-t --home ${HOME_DIR} --keyring-backend test --chain-id ${CHAIN_ID} --broadcast-mode sync -y -o json"

tx() { # tx <from> <gasargs...> -- <tx subcommand...>   broadcast, poll to commit
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
  echo "  committed: $txhash"
}

assert_eq() { # assert_eq <label> <got> <want>
  if [ "$2" = "$3" ]; then echo "  OK   $1 = $2"
  else echo "  FAIL $1: got '$2', want '$3'" >&2; exit 1; fi
}
assert_month_after() { # assert_month_after <label> <ym> <ref-ym>  (strictly later)
  if [[ "$2" > "$3" ]]; then echo "  OK   $1 = $2 (later than $3)"
  else echo "  FAIL $1: got '$2', want a month later than '$3'" >&2; exit 1; fi
}

VAULT="$(qj vault list | jq -r --arg d "$SHARE" '.vaults[]?|select(.total_shares.denom==$d)|.base_account.address' | head -1)"
[ -n "$VAULT" ] && [ "$VAULT" != "null" ] || { echo "no vault for '$SHARE'; run infra/devnet/bootstrap/nvhash-deploy-p2p.sh" >&2; exit 1; }
CONTRACT="$(qj vault get "$VAULT" | jq -r '.vault.asset_manager')"
[ -n "$CONTRACT" ] && [ "$CONTRACT" != "null" ] || { echo "vault $VAULT has no asset manager; run the bootstrap" >&2; exit 1; }
smart() { qj wasm contract-state smart "$CONTRACT" "$1" 2>/dev/null | jq -c "$2"; }

# Calendar month (YYYY-MM) of a Unix-seconds value, via the container's date.
secs_to_month() { docker exec "$CONTAINER" date -u -d "@$1" +%Y-%m; }
# Current consensus block time and its calendar month, straight off the header
# (the RFC3339 string carries YYYY-MM; no conversion needed).
block_time() { pexec status -t --home "$HOME_DIR" | jq -r '.sync_info.latest_block_time'; }

echo "vault=$VAULT contract=$CONTRACT"
BT="$(block_time)"
NOW_MONTH="${BT:0:7}"                       # YYYY-MM from the RFC3339 header time
LAST_RUN="$(smart '{"epoch_status":{}}' '.data.last_run_seconds' | tr -d '"')"
LAST_MONTH="$(secs_to_month "$LAST_RUN")"
echo "block time = $BT (month $NOW_MONTH); last_run = ${LAST_RUN}s (month $LAST_MONTH)"

# PHASE 1 — an eligible crank runs a full epoch end-to-end.
if [[ "$LAST_MONTH" < "$NOW_MONTH" ]]; then
  echo; echo "== PHASE 1: eligible crank (last_run month $LAST_MONTH < $NOW_MONTH) =="
  tx "$ADMIN" --gas 4000000 --fees "$CRANK_FEES" -- \
    wasm execute "$CONTRACT" '{"run_epoch":{}}'
  assert_eq "phase after crank" "$(smart '{"epoch_status":{}}' '.data.phase' | tr -d '"')" "Idle"
  assert_eq "epoch snapshot recorded" "$(smart '{"epoch_snapshot":{}}' '.data.snapshot != null')" "true"
  NEW_LAST="$(smart '{"epoch_status":{}}' '.data.last_run_seconds' | tr -d '"')"
  assert_eq "last_run advanced into the current month" "$(secs_to_month "$NEW_LAST")" "$NOW_MONTH"
else
  echo; echo "== PHASE 1: SKIPPED — contract already cranked this calendar month =="
  echo "  last_run month $LAST_MONTH == current $NOW_MONTH: the month is locked (cadence"
  echo "  working as designed). Reset+bootstrap the devnet for the full success path:"
  echo "    infra/devnet/dev-node.sh reset && infra/devnet/dev-node.sh bootstrap"
fi

# PHASE 2 — a second crank in the same calendar month is rejected.
echo; echo "== PHASE 2: same-month re-crank rejected =="
# The calendar gate only applies to a FRESH epoch. If a prior crank left
# continuation work queued, run_epoch legitimately drains it via continue_epoch,
# bypassing the gate — so the rejection assertion requires empty queues.
PD="$(smart '{"epoch_status":{}}' '.data.pending_delegations | length')"
PR="$(smart '{"epoch_status":{}}' '.data.pending_redelegations | length')"
if [ "$PD" != "0" ] || [ "$PR" != "0" ]; then
  echo "  FAIL: a continuation is pending (delegations=$PD redelegations=$PR); drain it" >&2
  echo "  with RunEpoch until phase Idle before asserting the calendar gate." >&2
  exit 1
fi
# --dry-run simulates the crank WITHOUT broadcasting (no state change): the
# predicate returns `too soon` and the CLI surfaces the contract error.
# Simulation mode does not consult the keyring, so --from must be the resolved
# bech32 address, not a key name.
ADMIN_ADDR="$(pexec keys show "$ADMIN" -a -t --home "$HOME_DIR" --keyring-backend test)"
OUT="$(pexec tx wasm execute "$CONTRACT" '{"run_epoch":{}}' --dry-run \
  -t --home "$HOME_DIR" --keyring-backend test --chain-id "$CHAIN_ID" \
  --gas-prices 1nhash --from "$ADMIN_ADDR" 2>&1 || true)"
echo "$OUT" | grep -q "too soon" \
  || { echo "  FAIL: expected a 'too soon' rejection; got:" >&2; echo "$OUT" | head -4 >&2; exit 1; }
echo "  OK   same-month crank rejected with 'too soon'"
NEXT="$(echo "$OUT" | grep -o 'next run allowed at [0-9]*' | grep -o '[0-9]*' | head -1)"
[ -n "$NEXT" ] || { echo "  FAIL: could not parse the next-eligible instant from the error" >&2; exit 1; }
NEXT_MONTH="$(secs_to_month "$NEXT")"
echo "  next eligible at ${NEXT}s (month $NEXT_MONTH)"
assert_month_after "next-eligible month" "$NEXT_MONTH" "$NOW_MONTH"

echo; echo "== calendar-drill PASSED =="
