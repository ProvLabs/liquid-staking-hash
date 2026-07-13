#!/usr/bin/env bash
# Shared plumbing for the dev-node console scripts. Each script sources this,
# which resolves the vault + contract from chain state and provides tx/query
# helpers against the dockerized dev node.
#
# Environment overrides (defaults match the drill environment):
#   CONTAINER=dev-node  CHAIN_ID=chain-dev  HOME_DIR=/provenance/nodedev
#   FROM=account-1      SHARE=nvhash        CONTRACT=<auto from vault>
set -euo pipefail

CONTAINER="${CONTAINER:-dev-node}"
CHAIN_ID="${CHAIN_ID:-chain-dev}"
HOME_DIR="${HOME_DIR:-/provenance/nodedev}"
FROM="${FROM:-account-1}"
SHARE="${SHARE:-nvhash}"
UNDERLYING="${UNDERLYING:-nhash}"
# RunEpoch settlement legs carry x/exchange flat creation/acceptance fees
# (defaults: 10 + 8 HASH); the crank caller pays them as tx fees.
CRANK_FEES="${CRANK_FEES:-30000000000nhash}"

pexec() { docker exec "$CONTAINER" provenanced "$@"; }
qj()    { pexec query "$@" -t --home "$HOME_DIR" -o json; }
addr_of() { pexec keys show "$1" -a -t --home "$HOME_DIR" --keyring-backend test; }
valoper_of() { pexec keys show "$1" -a --bech val -t --home "$HOME_DIR" --keyring-backend test; }

TXFLAGS="-t --home ${HOME_DIR} --keyring-backend test --chain-id ${CHAIN_ID} --broadcast-mode sync -y -o json"

# Resolve the deployed vault + contract once.
resolve() {
  VAULT="${VAULT:-$(qj vault list 2>/dev/null | jq -r --arg d "$SHARE" \
    '.vaults[]?|select(.total_shares.denom==$d)|.base_account.address' | head -1)}"
  [ -n "${VAULT:-}" ] && [ "$VAULT" != "null" ] || {
    echo "no vault found for share denom '$SHARE'; is the dev node bootstrapped? (scripts/nvhash-deploy-p2p.sh)" >&2
    exit 1
  }
  CONTRACT="${CONTRACT:-$(qj vault get "$VAULT" | jq -r '.vault.asset_manager')}"
  [ -n "$CONTRACT" ] && [ "$CONTRACT" != "null" ] || {
    echo "vault $VAULT has no asset manager set" >&2
    exit 1
  }
}

# tx <gasargs...> -- <tx subcommand...>   broadcast, poll to commit, print result
tx() {
  local gas=()
  while [ "$1" != "--" ]; do gas+=("$1"); shift; done; shift
  local errf out txhash code res i
  errf="$(mktemp)"
  # stderr kept apart: the CLI prints gas estimates there, which would corrupt
  # the JSON we parse for the tx hash.
  if ! out="$(pexec tx "$@" $TXFLAGS "${gas[@]}" --from "$FROM" 2>"$errf")"; then
    # A --gas auto simulation failure carries the contract's own rejection
    # message; surface that cleanly instead of the raw RPC wrapping.
    local core
    core="$(grep -o 'failed to execute message; message index: [0-9]*: .*' "$errf" \
      | head -1 | sed 's/failed to execute message; message index: [0-9]*: //; s/: execute wasm contract failed.*//')"
    if [ -n "$core" ]; then
      echo "REJECTED BY CONTRACT: $core" >&2
    else
      echo "BROADCAST FAILED:" >&2
      head -6 "$errf" >&2
    fi
    rm -f "$errf"
    exit 1
  fi
  rm -f "$errf"
  txhash="$(echo "$out" | jq -r '.txhash // empty' 2>/dev/null)"
  [ -n "$txhash" ] || { echo "BROADCAST FAILED: $out" | head -c 400 >&2; exit 1; }
  [ "$(echo "$out" | jq -r '.code')" = "0" ] || {
    echo "REJECTED: $(echo "$out" | jq -r '.raw_log')" >&2; exit 1; }
  for i in $(seq 1 30); do
    res="$(pexec query tx "$txhash" -t --home "$HOME_DIR" -o json 2>/dev/null || true)"
    code="$(echo "$res" | jq -r '.code // empty' 2>/dev/null || true)"
    [ -n "$code" ] && break; sleep 1
  done
  if [ "$code" = "0" ]; then
    echo "ok: $txhash"
  else
    echo "TX FAILED (code=${code:-?}): $(echo "$res" | jq -r '.raw_log // "not committed"' | head -c 500)" >&2
    exit 1
  fi
}

# execute <json-msg> [extra tx flags...]   wasm execute against the contract
execute() {
  local msg="$1"; shift
  resolve
  tx --gas auto --gas-adjustment 2.0 --gas-prices 1nhash "$@" -- \
    wasm execute "$CONTRACT" "$msg"
}

# smart <json-query> [jq filter]
smart() {
  local q="$1" filter="${2:-.data}"
  resolve
  qj wasm contract-state smart "$CONTRACT" "$q" | jq "$filter"
}
