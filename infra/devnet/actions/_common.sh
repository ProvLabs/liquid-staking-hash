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
    echo "no vault found for share denom '$SHARE'; is the dev node bootstrapped? (infra/devnet/bootstrap/nvhash-deploy-p2p.sh)" >&2
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
  local errf out txhash code res
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
  for _ in $(seq 1 30); do
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

# --- x/group governance (app plan PR 7.1) ----------------------------------
# The program's admin group policy. Discovery is deliberately the SAME shape the
# indexer uses (M7.1 plan §2.1): the contract's `Config.admin` is the entry
# point, never a hardcoded policy — the dual-policy split
# (contracts/IMPLEMENTATION-STATUS.md) is still open, so assuming "the" policy
# would be the topology assumption SECURITY.md forbids.
#
# `GOV_POLICY` overrides it, which is how these scripts work on a chain whose
# contract was deployed before the group existed (there is no admin-rotation
# message — M7 overview F2).
resolve_gov_policy() {
  if [ -n "${GOV_POLICY:-}" ]; then return 0; fi
  resolve
  GOV_POLICY="$(qj wasm contract-state smart "$CONTRACT" '{"config":{}}' 2>/dev/null | jq -r '.data.admin // empty')"
  [ -n "$GOV_POLICY" ] || { echo "could not read Config.admin from $CONTRACT" >&2; exit 1; }
  # Is it actually a group policy, or a plain account? A 404 here is the honest
  # "no governance behind the admin" state, not an error to paper over.
  if ! qj group group-policy-info "$GOV_POLICY" >/dev/null 2>&1; then
    echo "Config.admin ($GOV_POLICY) is a plain account, not an x/group policy." >&2
    echo "Bootstrap one with infra/devnet/bootstrap/nvhash-group-bootstrap.sh and either" >&2
    echo "redeploy with CONTRACT_ADMIN=<policy>, or set GOV_POLICY=<policy> to act on it" >&2
    echo "directly (see that script's warning)." >&2
    exit 1
  fi
}

# gov_group_id — the group behind the resolved policy.
gov_group_id() {
  resolve_gov_policy
  qj group group-policy-info "$GOV_POLICY" | jq -r '.info.group_id'
}

# Write a file inside the container (the group CLI takes file paths).
put_container_file() { docker exec -i "$CONTAINER" sh -c "cat > $1"; }

# gov_tx <from-key> -- <tx group subcommand...>   like tx(), with group gas.
# `tx` signs as the global $FROM, so swap it for this call and put it back —
# these scripts sign as a specific MEMBER, not as the default account.
gov_tx() {
  local from="$1" prev="$FROM"; shift
  [ "$1" = "--" ] && shift
  FROM="$from"
  tx --gas auto --gas-adjustment 2.0 --gas-prices 1nhash -- "$@"
  FROM="$prev"
}
