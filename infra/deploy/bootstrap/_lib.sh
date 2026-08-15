#!/usr/bin/env bash
# Shared library for the TESTNET bootstrap scripts (plan 8.4 §2.6).
# Deliberately NOT under infra/devnet/: the devnet scripts' container/keyring
# assumptions and throwaway-key posture must not blur into the real-network
# path, and SECURITY.md's "drills point at nothing else" rule stays intact —
# no devnet drill or action script is ever pointed here.
#
# Inherited idioms (nvhash-deploy-p2p.sh is the semantic reference):
# set -euo pipefail, the tx() broadcast-then-poll-then-assert wrapper,
# lookup-before-create idempotency. What changes: keys come ONLY from the
# secret store (§2.6.5), every step asserts its own ON-CHAIN effect and
# aborts on mismatch (§4 invariant 4), and the endpoint is an
# operator-supplied testnet node, never dev-node.
set -euo pipefail

# ── Fail-closed configuration (§4 invariant 3) ────────────────────────────

refuse() {
  echo "bootstrap: $1 — refusing before any side effect (D24 fail-closed; no --force exists)" >&2
  exit 1
}

is_placeholder() {
  local lower
  lower="$(tr '[:upper:]' '[:lower:]' <<<"$1")"
  [[ "$lower" =~ (placeholder|not-a-secret|example|change-?me|replace|sentinel|throwaway|set-at-deploy|xxxx) ]]
}

require_value() {
  local name="$1" value="${!1:-}"
  [[ -n "$value" ]] || refuse "$name is unset or empty"
  if is_placeholder "$value"; then refuse "$name matches a placeholder pattern"; fi
}

require_bech32() {
  local name="$1" value="${!1:-}"
  require_value "$name"
  [[ "$value" =~ ^[a-z]+1[a-z0-9]{8,90}$ ]] || refuse "$name is not bech32-shaped: $value"
}

# ── Environment (operator-supplied; all public facts) ─────────────────────
# TESTNET_NODE   the RPC endpoint of an operator-chosen testnet node
# TESTNET_LCD    the LCD endpoint (probe + assertions read through it)
# CHAIN_ID       pio-testnet-1 (verified against the node before any tx)

TESTNET_NODE="${TESTNET_NODE:-}"
TESTNET_LCD="${TESTNET_LCD:-}"
CHAIN_ID="${CHAIN_ID:-pio-testnet-1}"

GAS_ARGS=(--gas auto --gas-adjustment 2.0 --gas-prices 1nhash)

# The probe success marker: every post-probe script REFUSES to run without it
# (D27 — no "deploy anyway" flag exists). Lives beside the scripts' state dir,
# which holds ONLY public facts (never key material).
SDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${BOOTSTRAP_STATE_DIR:-$SDIR/.state}"
PROBE_MARKER="$STATE_DIR/accept-asset-probe.ok"

require_probe_passed() {
  [[ -f "$PROBE_MARKER" ]] || refuse "the AcceptAsset probe has not passed (run probe-accept-asset.sh first; D27: probe fails ⇒ the pilot WAITS)"
}

# ── Store-only key access (§2.6.5) ─────────────────────────────────────────
# `store_get <path>` must be on PATH — the thin wrapper over the environment's
# secret-store CLI (the same store ESO reads, §7 Q1). No argument and no file
# ever accepts a key; the keyring is an EPHEMERAL tmpdir removed on exit.

KEYRING_DIR=""
PILOT_KEY_NAME="pilot-ops"

setup_pilot_key() {
  command -v store_get >/dev/null || refuse "no store_get on PATH — the secret store is the ONLY key source"
  command -v provenanced >/dev/null || refuse "provenanced not on PATH"
  KEYRING_DIR="$(mktemp -d)"
  chmod 0700 "$KEYRING_DIR"
  trap 'rm -rf "$KEYRING_DIR"' EXIT
  # The key transits process memory and the ephemeral keyring only — stdin,
  # never argv (a process listing must not see it) and never a repo file.
  store_get "testnet/PILOT_OPS_KEY_HEX" \
    | provenanced keys import-hex "$PILOT_KEY_NAME" /dev/stdin \
        --home "$KEYRING_DIR" --keyring-backend test >/dev/null
  # shellcheck disable=SC2034 # consumed by the sourcing scripts, not here
  PILOT_ADDR="$(provenanced keys show "$PILOT_KEY_NAME" -a -t --home "$KEYRING_DIR" --keyring-backend test)"
  require_bech32 PILOT_ADDR
}

# ── Chain access ───────────────────────────────────────────────────────────

lcd_get() {
  curl -fsS "${TESTNET_LCD}$1" -H 'accept: application/json'
}

qj() {
  provenanced query "$@" --node "$TESTNET_NODE" -t -o json
}

# Broadcast, poll to inclusion, assert code 0 — the devnet tx() wrapper with
# the ephemeral keyring. Prints the INCLUDED tx JSON on stdout.
tx() {
  echo "+ tx $*" >&2
  local out code txhash res
  out="$(provenanced tx "$@" \
    --from "$PILOT_KEY_NAME" --home "$KEYRING_DIR" --keyring-backend test \
    --node "$TESTNET_NODE" --chain-id "$CHAIN_ID" "${GAS_ARGS[@]}" \
    -t --broadcast-mode sync -y -o json 2>/dev/null)"
  code="$(jq -r '.code // empty' <<<"$out")"
  txhash="$(jq -r '.txhash // empty' <<<"$out")"
  [[ -n "$txhash" ]] || { echo "TX BROADCAST FAILED: $out" >&2; exit 1; }
  [[ "$code" == "0" ]] || { echo "TX REJECTED (code=$code): $(jq -r '.raw_log' <<<"$out")" >&2; exit 1; }
  for _ in $(seq 1 30); do
    sleep 2
    if res="$(qj tx "$txhash" 2>/dev/null)"; then
      code="$(jq -r '.code' <<<"$res")"
      [[ "$code" == "0" ]] || { echo "TX FAILED AT INCLUSION (code=$code): $(jq -r '.raw_log' <<<"$res")" >&2; exit 1; }
      echo "$res"
      return 0
    fi
  done
  echo "TX $txhash not observed included — aborting (never assume success)" >&2
  exit 1
}

# assert "<description>" <actual> <expected> — reads, not tx codes (§4 inv 4).
assert_eq() {
  local what="$1" actual="$2" expected="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "ASSERTION FAILED: $what — expected '$expected', chain says '$actual'" >&2
    echo "The sequence ABORTS here; re-run after diagnosis (every step is idempotent by lookup)." >&2
    exit 1
  fi
  echo "  ok: $what = $expected" >&2
}

# Verify the node really is the configured chain BEFORE the first tx.
assert_chain_id() {
  local node_chain
  node_chain="$(lcd_get /cosmos/base/tendermint/v1beta1/node_info | jq -r '.default_node_info.network')"
  assert_eq "node network" "$node_chain" "$CHAIN_ID"
}
