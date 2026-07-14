#!/usr/bin/env bash
# capture-fixtures.sh — capture the devnet fixture corpus (app plan PR 0.2).
#
# Captures, verbatim, every message/event/query shape the App decodes from the
# chain (app-spec §14.2 stage 1), from a devnet that has been driven through
# the full money path by contracts/drills/ plus the refund scenario
# (scripts/generate-corpus.sh). Then verifies the corpus against the required
# inventory — swap in, swap out (enqueue), expedite, payout, refund, RunEpoch
# settlement — and FAILS if any terminal state is missing. Completeness is
# verified, not assumed.
#
# PROVISIONAL STATUS: the settlement-era vault module has no formal upstream
# release; the capture runs against a development build identified by FEATURE
# PROBE (AcceptAsset present), never a version pin. Captured shapes pin our
# assumptions so drift is detectable; they do not certify compatibility. The
# corpus must be re-captured and diffed against the vault's formal release
# before any App release is certified (app plan PR 8.0).
#
# Usage:
#   scripts/capture-fixtures.sh            capture + verify (writes fixtures/)
#   scripts/capture-fixtures.sh --check    verify an existing corpus only
#
# Environment (defaults match infra/devnet):
#   CONTAINER=dev-node  LCD=http://localhost:1317  RPC=http://localhost:26657
#   HOME_DIR=/provenance/nodedev  SHARE=nvhash
set -euo pipefail

SDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-$SDIR/../fixtures}"
CONTAINER="${CONTAINER:-dev-node}"
LCD="${LCD:-http://localhost:1317}"
RPC="${RPC:-http://localhost:26657}"
HOME_DIR="${HOME_DIR:-/provenance/nodedev}"
SHARE="${SHARE:-nvhash}"
MODE="${1:-capture}"

# ---------------------------------------------------------------------------
# Event/message type pins (discovered 2026-07-14 against the AcceptAsset dev
# build). If the vault release renames any of these, capture fails loudly —
# that is the drift detection working, not a script bug. Amounts inside vault
# event attributes are JSON-encoded strings (extra quoting), e.g.
# "\"500000000000nhash\"" — decoders must unwrap one JSON-string layer.
MSG_SWAP_IN="/provlabs.vault.v1.MsgSwapInRequest"
MSG_SWAP_OUT="/provlabs.vault.v1.MsgSwapOutRequest"
EV_SWAP_IN="provlabs.vault.v1.EventSwapIn"
EV_SWAP_OUT_REQUESTED="provlabs.vault.v1.EventSwapOutRequested"   # enqueue
EV_SWAP_OUT_COMPLETED="provlabs.vault.v1.EventSwapOutCompleted"   # payout (EndBlocker)
EV_SWAP_OUT_REFUNDED="provlabs.vault.v1.EventSwapOutRefunded"     # unfunded maturity (EndBlocker)
EV_EXPEDITED="provlabs.vault.v1.EventPendingSwapOutExpedited"     # expedite (inside a crank tx)
EV_MARKER_BURN="provenance.marker.v1.EventMarkerBurn"             # return-settlement burn leg
EV_MARKER_MINT="provenance.marker.v1.EventMarkerMint"             # deploy-settlement mint leg
EV_PAYMENT_CREATED="provenance.exchange.v1.EventPaymentCreated"   # settlement payment leg
EV_PAYMENT_ACCEPTED="provenance.exchange.v1.EventPaymentAccepted" # settlement acceptance
EV_ASSET_ACCEPTED="provlabs.vault.v1.EventAssetAccepted"          # the AcceptAsset leg itself

fail() { echo "FAIL: $*" >&2; exit 1; }
note() { echo "  $*"; }

pexec() { docker exec "$CONTAINER" provenanced "$@"; }
cli_q() { pexec query "$@" -t --home "$HOME_DIR" -o json; }

# --- feature probe ----------------------------------------------------------
# AcceptAsset present => settlement-era development build. This is the ONLY
# accepted compatibility signal until a formal vault release exists
# (contracts/IMPLEMENTATION-STATUS.md §3; app plan §1 upstream status).
feature_probe() {
  pexec tx vault accept-asset --help >/dev/null 2>&1 \
    || fail "feature probe: 'tx vault accept-asset' absent — this node does not run the settlement-era vault module; refusing to capture"
  echo "ok: feature probe — AcceptAsset present (development build; no upstream version to pin)"
}

# --- capture helpers --------------------------------------------------------
tx_search() { # tx_search <query> -> latest txhash or empty
  # CometBFT RPC requires the query VALUE itself to be a quoted string.
  curl -sf --get "$RPC/tx_search" \
    --data-urlencode "query=\"$1\"" --data-urlencode 'per_page=1' \
    --data-urlencode 'order_by="desc"' | jq -r '.result.txs[0].hash // empty'
}

block_search() { # block_search <query> -> latest height or empty
  curl -sf --get "$RPC/block_search" \
    --data-urlencode "query=\"$1\"" --data-urlencode 'per_page=1' \
    --data-urlencode 'order_by="desc"' | jq -r '.result.blocks[0].block.header.height // empty'
}

tx_search_with() { # tx_search_with <query> <also-required event type> -> latest txhash
  # The kv indexer does not match AND conditions across different event types,
  # so the second condition is applied client-side.
  curl -sf --get "$RPC/tx_search" \
    --data-urlencode "query=\"$1\"" --data-urlencode 'per_page=50' \
    --data-urlencode 'order_by="desc"' \
    | jq -r --arg t "$2" \
      '[.result.txs[] | select([.tx_result.events[].type] | index($t))][0].hash // empty'
}

capture_lcd_tx() { # capture_lcd_tx <file> <txhash>  (verbatim LCD GetTx shape)
  curl -sf "$LCD/cosmos/tx/v1beta1/txs/$2" > "$1" \
    || fail "LCD tx fetch failed for $2"
  note "$(basename "$1") <- tx $2"
}

capture_block_results() { # capture_block_results <file> <height> (verbatim RPC)
  curl -sf "$RPC/block_results?height=$2" | jq '.result' > "$1" \
    || fail "block_results fetch failed at height $2"
  note "$(basename "$1") <- block $2 (EndBlocker plane: finalize_block_events, txs_results empty)"
}

capture_smart() { # capture_smart <file> <contract> <query-json> (verbatim LCD)
  local b64; b64="$(printf '%s' "$3" | base64 | tr -d '\n')"
  curl -sf "$LCD/cosmwasm/wasm/v1/contract/$2/smart/$b64" > "$1" \
    || fail "smart query failed: $3"
  note "$(basename "$1") <- smart $3"
}

capture_cli() { # capture_cli <file> <query args...>  (proto JSON via CLI/gRPC,
  # for the queries grpc-gateway cannot serve — see estimate-swap-in below)
  local f="$1"; shift
  cli_q "$@" > "$f" || fail "CLI query failed: $*"
  note "$(basename "$f") <- provenanced query $*"
}

capture_lcd() { # capture_lcd <file> <path> (verbatim LCD)
  curl -sf "$LCD/$2" > "$1" || fail "LCD fetch failed: /$2"
  note "$(basename "$1") <- LCD /$2"
}

# --- capture ----------------------------------------------------------------
capture() {
  echo "== feature probe"
  feature_probe

  echo "== resolving chain context"
  local chain_id height vault contract
  chain_id="$(curl -sf "$RPC/status" | jq -r '.result.node_info.network')"
  height="$(curl -sf "$RPC/status" | jq -r '.result.sync_info.latest_block_height')"
  vault="$(cli_q vault list | jq -r --arg d "$SHARE" \
    '.vaults[]?|select(.total_shares.denom==$d)|.base_account.address' | head -1)"
  [ -n "$vault" ] || fail "no vault with share denom '$SHARE' — bootstrap the devnet first"
  contract="$(cli_q vault get "$vault" | jq -r '.vault.asset_manager')"
  [ -n "$contract" ] && [ "$contract" != "null" ] || fail "vault has no asset manager"
  note "chain=$chain_id height=$height vault=$vault contract=$contract"

  mkdir -p "$OUT"/{msgs,run-epoch,block-events,queries/vault,queries/contract,queries/staking}

  echo "== message + tx-event shapes (LCD /cosmos/tx/v1beta1/txs/{hash}, verbatim)"
  local h_swap_in h_swap_out h_expedite h_deploy h_return
  h_swap_in="$(tx_search "message.action='$MSG_SWAP_IN'")"
  [ -n "$h_swap_in" ] || fail "no $MSG_SWAP_IN tx on chain — run the drills first"
  capture_lcd_tx "$OUT/msgs/swap-in.json" "$h_swap_in"

  h_swap_out="$(tx_search "message.action='$MSG_SWAP_OUT'")"
  [ -n "$h_swap_out" ] || fail "no $MSG_SWAP_OUT tx on chain"
  capture_lcd_tx "$OUT/msgs/swap-out.json" "$h_swap_out"

  echo "== RunEpoch crank txs (settlement legs + expedite; wasm action attrs)"
  h_deploy="$(tx_search_with "$EV_PAYMENT_ACCEPTED.target EXISTS" "$EV_MARKER_MINT")"
  [ -n "$h_deploy" ] || fail "no crank tx with $EV_PAYMENT_ACCEPTED + $EV_MARKER_MINT (deploy settlement)"
  capture_lcd_tx "$OUT/run-epoch/deploy-settlement.json" "$h_deploy"

  h_return="$(tx_search_with "$EV_PAYMENT_ACCEPTED.target EXISTS" "$EV_MARKER_BURN")"
  [ -n "$h_return" ] || fail "no crank tx with $EV_PAYMENT_ACCEPTED + $EV_MARKER_BURN (return settlement)"
  capture_lcd_tx "$OUT/run-epoch/return-settlement.json" "$h_return"

  h_expedite="$(tx_search "$EV_EXPEDITED.request_id EXISTS")"
  [ -n "$h_expedite" ] || fail "no crank tx carrying $EV_EXPEDITED (expedite)"
  capture_lcd_tx "$OUT/run-epoch/expedite.json" "$h_expedite"

  echo "== EndBlocker plane (RPC block_results, verbatim — NOT visible to tx-search)"
  local b_paid b_refund
  b_paid="$(block_search "$EV_SWAP_OUT_COMPLETED.vault_address EXISTS")"
  [ -n "$b_paid" ] || fail "no block carrying $EV_SWAP_OUT_COMPLETED (payout)"
  capture_block_results "$OUT/block-events/swap-out-completed.json" "$b_paid"

  b_refund="$(block_search "$EV_SWAP_OUT_REFUNDED.vault_address EXISTS")"
  [ -n "$b_refund" ] || fail "no block carrying $EV_SWAP_OUT_REFUNDED (unfunded-maturity refund) — run scripts/generate-corpus.sh"
  capture_block_results "$OUT/block-events/swap-out-refunded.json" "$b_refund"

  echo "== vault module query shapes (LCD REST under /vault/v1 — NOT /provlabs/vault/v1)"
  capture_lcd "$OUT/queries/vault/get.json"                "vault/v1/vaults/$vault"
  capture_lcd "$OUT/queries/vault/list.json"               "vault/v1/vaults"
  capture_lcd "$OUT/queries/vault/params.json"             "vault/v1/params"
  capture_lcd "$OUT/queries/vault/pending-swap-outs.json"  "vault/v1/vaults/$vault/pending_swap_outs"
  capture_lcd "$OUT/queries/vault/payments.json"           "vault/v1/vaults/$vault/payments"
  # estimate_swap_out serves over REST (string fields); estimate_swap_in does
  # NOT — grpc-gateway rejects Coin/math.Int query parameters ("field type
  # *types.Coin is not supported"), so that one query is gRPC/CLI-only.
  capture_lcd "$OUT/queries/vault/estimate-swap-out.json"  "vault/v1/vaults/$vault/estimate_swap_out?shares=1000000000000"
  capture_cli "$OUT/queries/vault/estimate-swap-in.json"   vault estimate-swap-in "$vault" 1000000000nhash
  echo "== contract smart query shapes (LCD /cosmwasm/wasm/v1, verbatim)"
  capture_smart "$OUT/queries/contract/config.json"         "$contract" '{"config":{}}'
  capture_smart "$OUT/queries/contract/epoch-status.json"   "$contract" '{"epoch_status":{}}'
  capture_smart "$OUT/queries/contract/epoch-snapshot.json" "$contract" '{"epoch_snapshot":{}}'
  capture_smart "$OUT/queries/contract/apr.json"            "$contract" '{"apr":{}}'
  capture_smart "$OUT/queries/contract/validators.json"     "$contract" '{"validators":{}}'
  capture_smart "$OUT/queries/contract/jail-reports.json"   "$contract" '{"jail_reports":{}}'

  echo "== staking + group query shapes (LCD, verbatim)"
  capture_lcd "$OUT/queries/staking/validators.json"  "cosmos/staking/v1beta1/validators"
  capture_lcd "$OUT/queries/staking/delegations.json" "cosmos/staking/v1beta1/delegations/$contract"
  mkdir -p "$OUT/queries/group"
  # No group exists on the drill devnet; the empty response still pins the
  # pagination envelope shape the group client decodes.
  capture_lcd "$OUT/queries/group/groups.json"        "cosmos/group/v1/groups"

  echo "== manifest"
  jq -n \
    --arg chain_id "$chain_id" \
    --arg height "$height" \
    --arg captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg image "$(docker image inspect provenance-io/blockchain-dev:latest --format '{{.Id}}' 2>/dev/null || echo unknown)" \
    --arg vault "$vault" --arg contract "$contract" \
    --arg tx_swap_in "$h_swap_in" --arg tx_swap_out "$h_swap_out" \
    --arg tx_deploy "$h_deploy" --arg tx_return "$h_return" \
    --arg tx_expedite "$h_expedite" \
    --arg blk_paid "$b_paid" --arg blk_refund "$b_refund" \
    '{
      status: "PROVISIONAL — captured against a pre-release vault development build identified by feature probe (AcceptAsset present); no upstream version exists to pin. Re-capture and diff against the formal vault release before certifying any App release (app plan PR 8.0).",
      feature_probe: { name: "AcceptAsset", result: "present" },
      chain_id: $chain_id, captured_at: $captured_at, head_height: ($height|tonumber),
      node_image: $image, vault: $vault, contract: $contract,
      pinned_facts: [
        "vault msg type URLs carry a Request suffix (MsgSwapInRequest, MsgSwapOutRequest)",
        "vault event attribute values are JSON-encoded strings (one extra quoting layer)",
        "payout and refund are EndBlocker events (finalize_block_events via RPC block_results); they never appear in tx-search",
        "block_search indexes EndBlocker events on this build (kv indexer)",
        "vault LCD REST paths live under /vault/v1 (NOT /provlabs/vault/v1)",
        "estimate_swap_in is gRPC/CLI-only: grpc-gateway rejects Coin/math.Int query parameters; estimate_swap_out (string fields) serves over REST",
        "contract cranks emit plain wasm events with action attributes; epoch snapshot/APR data is read by smart query, not events"
      ],
      sources: {
        swap_in_tx: $tx_swap_in, swap_out_tx: $tx_swap_out,
        deploy_settlement_tx: $tx_deploy, return_settlement_tx: $tx_return,
        expedite_tx: $tx_expedite,
        payout_block: ($blk_paid|tonumber), refund_block: ($blk_refund|tonumber)
      }
    }' > "$OUT/manifest.json"
  note "manifest.json written"
}

# --- completeness gate ------------------------------------------------------
# The corpus is complete only if every required terminal state is present in
# the captured files. Checked on every capture AND standalone via --check.
require() { # require <file> <marker> <label>
  local f="$OUT/$1"
  [ -s "$f" ] || { MISSING+=("$3 — file $1 missing/empty"); return; }
  grep -q "$2" "$f" || MISSING+=("$3 — $1 lacks '$2'")
}

check_corpus() {
  echo "== completeness gate (required event inventory)"
  MISSING=()
  require "msgs/swap-in.json"                     "$MSG_SWAP_IN"           "swap in (msg)"
  require "msgs/swap-in.json"                     "$EV_SWAP_IN"            "swap in (event)"
  require "msgs/swap-out.json"                    "$MSG_SWAP_OUT"          "swap out (msg)"
  require "msgs/swap-out.json"                    "$EV_SWAP_OUT_REQUESTED" "enqueue (event)"
  require "run-epoch/deploy-settlement.json"      "$EV_PAYMENT_ACCEPTED"   "RunEpoch deploy settlement (payment leg)"
  require "run-epoch/deploy-settlement.json"      "$EV_ASSET_ACCEPTED"     "RunEpoch deploy settlement (AcceptAsset leg)"
  require "run-epoch/deploy-settlement.json"      "$EV_MARKER_MINT"        "RunEpoch deploy settlement (receipt mint leg)"
  require "run-epoch/return-settlement.json"      "$EV_MARKER_BURN"        "RunEpoch return settlement (burn leg)"
  require "run-epoch/return-settlement.json"      "$EV_ASSET_ACCEPTED"     "RunEpoch return settlement (AcceptAsset leg)"
  require "run-epoch/expedite.json"               "$EV_EXPEDITED"          "expedite"
  require "block-events/swap-out-completed.json"  "$EV_SWAP_OUT_COMPLETED" "payout (EndBlocker)"
  require "block-events/swap-out-refunded.json"   "$EV_SWAP_OUT_REFUNDED"  "refund (EndBlocker)"
  require "manifest.json"                         "PROVISIONAL"            "manifest provisional status"
  for f in queries/vault/get.json queries/vault/estimate-swap-in.json \
           queries/vault/estimate-swap-out.json queries/vault/pending-swap-outs.json \
           queries/contract/epoch-snapshot.json queries/contract/apr.json \
           queries/contract/epoch-status.json queries/contract/validators.json \
           queries/staking/validators.json queries/group/groups.json; do
    [ -s "$OUT/$f" ] || MISSING+=("query shape — $f missing/empty")
  done
  if [ "${#MISSING[@]}" -gt 0 ]; then
    echo "CORPUS INCOMPLETE — ${#MISSING[@]} required item(s) missing:" >&2
    printf '  - %s\n' "${MISSING[@]}" >&2
    exit 1
  fi
  echo "ok: corpus complete — all required terminal states present"
}

case "$MODE" in
  capture) capture; check_corpus ;;
  --check) check_corpus ;;
  *) echo "usage: $0 [--check]" >&2; exit 1 ;;
esac
