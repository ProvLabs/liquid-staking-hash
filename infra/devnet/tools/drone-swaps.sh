#!/usr/bin/env bash
# drone-swaps.sh — loop random swap-ins (and occasional swap-outs) from the drone accounts
# against the nvHASH vault (the one whose asset_manager is the staking contract).
#
# Each iteration is a swap-in (deposit nhash -> mint nvHASH shares) EXCEPT every Nth iteration
# (SWAP_OUT_EVERY, default 10 -> ~1 in 10) which is a swap-out: a drone holding shares redeems
# a random portion back to nhash. A swap-out enqueues a PendingSwapOut subject to the vault's
# withdrawal_delay; the contract's RunEpoch then unbonds liquidity to cover it.
#
# Targets the nvHASH vault by discovery (asset_manager answers {"config":{}}); override with
# VAULT=<addr> or SHARE=<denom>.
#
# Usage:
#   ./drone-swaps.sh                          # loop forever, ~5s apart, 1-in-10 swap-out
#   COUNT=40 INTERVAL=2 SWAP_OUT_EVERY=5 ./drone-swaps.sh
#   MIN_NHASH=1000000 MAX_NHASH=5000000000 ./drone-swaps.sh
set -uo pipefail

CONTAINER="${CONTAINER:-dev-node}"
CHAIN_ID="${CHAIN_ID:-chain-dev}"
HOME_DIR="${HOME_DIR:-/provenance/nodedev}"
read -r -a DRONES <<< "${DRONES:-drone-1 drone-2 drone-3}"
INTERVAL="${INTERVAL:-5}"
COUNT="${COUNT:-0}"                  # 0 = run forever
SWAP_OUT_EVERY="${SWAP_OUT_EVERY:-100}" # every Nth iteration is a swap-out (1-in-N); rare by default
SWAP_OUT_MIN_PCT="${SWAP_OUT_MIN_PCT:-1}"  # a swap-out redeems a small random % of the drone's shares
SWAP_OUT_MAX_PCT="${SWAP_OUT_MAX_PCT:-10}"
MIN_NHASH="${MIN_NHASH:-10000000}"   # min swap-in (1e7 nhash)
MAX_NHASH="${MAX_NHASH:-1000000000}" # max swap-in (1e9 nhash)
VAULT="${VAULT:-}"                   # explicit vault address (else discover)
SHARE="${SHARE:-}"                   # or resolve the vault by share denom
# Periodically fire the contract's RunEpoch crank (claim · service · deploy). Default 600s =
# 10 min = the chain's staking unbonding window. 0 disables. run_epoch is permissionless.
EPOCH_INTERVAL_SECS="${EPOCH_INTERVAL_SECS:-600}"
EPOCH_FROM="${EPOCH_FROM:-account-1}" # signer for RunEpoch

GAS_ARGS="--gas auto --gas-adjustment 1.5 --gas-prices 1nhash"
COMMON="-t --home ${HOME_DIR} --keyring-backend test --chain-id ${CHAIN_ID} ${GAS_ARGS} --broadcast-mode sync -y -o json"

pexec() { docker exec "$CONTAINER" provenanced "$@"; }
qj()    { pexec query "$@" -t --home "$HOME_DIR" -o json 2>/dev/null; }
addr_of() { pexec keys show "$1" -a -t --home "$HOME_DIR" --keyring-backend test 2>/dev/null; }

# Broadcast a tx (sync) from $1 and WAIT for commit before returning, so back-to-back txs from
# the same drone can't race the account sequence. Logs ok/REJECTED/FAIL; never aborts the loop.
fire() {
  local from="$1"; shift
  local out code hash res j
  out="$(pexec tx "$@" --from "$from" $COMMON 2>/dev/null)"
  code="$(echo "$out" | jq -r '.code // empty' 2>/dev/null)"
  hash="$(echo "$out" | jq -r '.txhash // empty' 2>/dev/null)"
  if [ -z "$hash" ]; then
    echo "    FAIL (no broadcast: $(echo "$out" | tr '\n' ' ' | head -c 120))"
    return
  fi
  if [ -n "$code" ] && [ "$code" != "0" ]; then
    echo "    REJECTED code=$code $(echo "$out" | jq -r '.raw_log // empty' | head -c 140)"
    return
  fi
  for j in $(seq 1 15); do
    res="$(qj tx "$hash")"
    code="$(echo "$res" | jq -r '.code // empty' 2>/dev/null)"
    [ -n "$code" ] && break
    sleep 1
  done
  if [ "$code" = "0" ]; then
    echo "    ok ${hash:0:12}"
  else
    echo "    FAIL code=${code:-timeout} $(echo "$res" | jq -r '.raw_log // empty' 2>/dev/null | head -c 140)"
  fi
}

rand_amt() {
  local min="$1" max="$2" span
  span=$((max - min + 1))
  echo $(( (RANDOM * 32768 + RANDOM) % span + min ))
}

# Share balance of a drone (the vault share denom); "0" if none.
share_bal() { qj bank balances "$1" | jq -r --arg s "$SHARE_DENOM" '(.balances[]?|select(.denom==$s)|.amount) // "0"'; }

discover_vault() {
  local v am
  for v in $(qj vault list | jq -r '.vaults[]?.base_account.address'); do
    am="$(qj vault get "$v" | jq -r '.vault.asset_manager // empty')"
    [ -n "$am" ] || continue
    if qj wasm contract-state smart "$am" '{"config":{}}' | jq -e '.data.receipt_denom' >/dev/null 2>&1; then
      echo "$v"; return 0
    fi
  done
}

# A swap-in from a random drone (random nhash amount).
do_swapin() {
  local d amt owner
  d="${DRONES[$((RANDOM % ${#DRONES[@]}))]}"
  amt="$(rand_amt "$MIN_NHASH" "$MAX_NHASH")"
  owner="$(addr_of "$d")"
  echo "[$i] swap-in  $d -> $SHARE_DENOM (${amt}${DEPOSIT_DENOM})"
  fire "$d" vault swap-in "$owner" "$VAULT" "${amt}${DEPOSIT_DENOM}"
}

# A swap-out from a drone that holds shares (redeem a random 5-50% of its balance). Returns 1
# if no drone holds any shares (caller falls back to a swap-in).
do_swapout() {
  local d owner bal pct amt
  # try a random starting drone, then the rest, until one has shares
  local order=("${DRONES[@]}")
  local start=$((RANDOM % ${#order[@]}))
  local k idx
  for ((k = 0; k < ${#order[@]}; k++)); do
    idx=$(((start + k) % ${#order[@]}))
    d="${order[$idx]}"
    owner="$(addr_of "$d")"
    bal="$(share_bal "$owner")"
    if [ -n "$bal" ] && [ "$bal" != "0" ]; then
      pct=$((RANDOM % (SWAP_OUT_MAX_PCT - SWAP_OUT_MIN_PCT + 1) + SWAP_OUT_MIN_PCT)) # small slice
      amt=$((bal * pct / 100))
      [ "$amt" -lt 1 ] && amt=1
      echo "[$i] swap-out $d -> redeem ${amt}${SHARE_DENOM} for $DEPOSIT_DENOM (${pct}% of $bal)"
      fire "$d" vault swap-out "$owner" "$VAULT" "${amt}${SHARE_DENOM}" "$DEPOSIT_DENOM"
      return 0
    fi
  done
  return 1
}

echo "== waiting for node =="
until [ "$(pexec status -t --home "$HOME_DIR" 2>/dev/null | jq -r '.sync_info.latest_block_height // 0')" -ge 1 ] 2>/dev/null; do
  sleep 2
done

if [ -z "$VAULT" ] && [ -n "$SHARE" ]; then
  VAULT="$(qj vault list | jq -r --arg d "$SHARE" '.vaults[]?|select(.total_shares.denom==$d)|.base_account.address' | head -1)"
fi
[ -n "$VAULT" ] || VAULT="$(discover_vault)"
[ -n "$VAULT" ] || { echo "no nvHASH vault found (run nvhash-deploy.sh first, or set VAULT=)" >&2; exit 1; }

UNDERLYING="$(qj vault get "$VAULT" | jq -r '.vault.underlying_asset')"
PAYMENT="$(qj vault get "$VAULT" | jq -r '.vault.payment_denom // empty')"
SHARE_DENOM="$(qj vault get "$VAULT" | jq -r '.vault.total_shares.denom')"
SWAP_IN_ON="$(qj vault get "$VAULT" | jq -r '.vault.swap_in_enabled')"
SWAP_OUT_ON="$(qj vault get "$VAULT" | jq -r '.vault.swap_out_enabled')"
# Drones deposit/redeem the bond denom (nhash) — what they actually hold. The vault accepts it
# whether it's the underlying (old design) or the payment denom (current: underlying=receipt).
# DEPOSIT_DENOM defaults to nhash; override if a vault uses a different deposit asset.
DEPOSIT_DENOM="${DEPOSIT_DENOM:-nhash}"
CONTRACT="$(qj vault get "$VAULT" | jq -r '.vault.asset_manager // empty')"
echo "  vault   = $VAULT (share=$SHARE_DENOM, underlying=$UNDERLYING, payment=${PAYMENT:-—})"
echo "  contract = ${CONTRACT:-<none>}  (RunEpoch every ${EPOCH_INTERVAL_SECS}s via $EPOCH_FROM)"
echo "  deposit/redeem denom = $DEPOSIT_DENOM"
echo "  swap-in=$SWAP_IN_ON  swap-out=$SWAP_OUT_ON  (1 swap-out per ${SWAP_OUT_EVERY} iterations)"
[ "$SWAP_IN_ON" = "true" ] || echo "  WARNING: swap-in disabled — swap-ins will fail until the admin enables it."
[ "$SWAP_OUT_ON" = "true" ] || echo "  WARNING: swap-out disabled — swap-outs will fail until the admin enables it."
if [ "$DEPOSIT_DENOM" != "$UNDERLYING" ] && [ "$DEPOSIT_DENOM" != "$PAYMENT" ]; then
  echo "  WARNING: $DEPOSIT_DENOM is neither the vault underlying nor payment — swaps will be rejected."
fi

for d in "${DRONES[@]}"; do
  a="$(addr_of "$d")"
  [ -n "$a" ] || { echo "drone '$d' not in keyring — run run-all.sh first" >&2; exit 1; }
done
echo "== starting swap loop (interval=${INTERVAL}s, count=${COUNT:-inf}) =="

trap 'echo; echo "stopped after $i swaps"; exit 0' INT TERM

epoch_at=$((SECONDS + EPOCH_INTERVAL_SECS)) # next RunEpoch firing
i=0
while [ "$COUNT" -eq 0 ] || [ "$i" -lt "$COUNT" ]; do
  i=$((i + 1))
  if [ $((i % SWAP_OUT_EVERY)) -eq 0 ]; then
    do_swapout || { echo "    (no drone holds shares yet — doing a swap-in instead)"; do_swapin; }
  else
    do_swapin
  fi
  # Fire the epoch crank on the unbonding cadence so deployed principal + redemptions get serviced.
  if [ "$EPOCH_INTERVAL_SECS" -gt 0 ] && [ -n "$CONTRACT" ] && [ "$SECONDS" -ge "$epoch_at" ]; then
    echo "[$i] === RunEpoch (every ${EPOCH_INTERVAL_SECS}s) ==="
    fire "$EPOCH_FROM" wasm execute "$CONTRACT" '{"run_epoch":{}}'
    epoch_at=$((SECONDS + EPOCH_INTERVAL_SECS))
  fi
  sleep "$INTERVAL"
done
echo "== done ($i swaps) =="
