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
#   IMAGE=ghcr.io/provlabs/vault-dev-node:latest  (manifest provenance only)
set -euo pipefail

SDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-$SDIR/../fixtures}"
CONTAINER="${CONTAINER:-dev-node}"
IMAGE="${IMAGE:-ghcr.io/provlabs/vault-dev-node:latest}"
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
MSG_EXECUTE="/cosmwasm.wasm.v1.MsgExecuteContract"                # operator actions ride this
# Contract wasm `action` attribute values (App M6.4 §2.1). Unlike vault event
# values these arrive BARE (no JSON-string layer). pay_commission carries the
# per-payment `amount`; pay_tip carries only the epoch-cumulative `tip_epoch`,
# so a tip's own nhash comes from the msg's attached funds — the same-msg_index
# bank `transfer` to the contract.
ACT_REGISTER="register_participation"
ACT_PAY_COMMISSION="pay_commission"
ACT_PAY_TIP="pay_tip"

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

tx_search_filtered() { # tx_search_filtered <query> <must-have type|""> <must-not-have types…>
  # -> latest matching txhash. The kv indexer does not match AND conditions
  # across different event types, so beyond the indexed query everything is
  # filtered client-side. The must-not list keeps overlapping crank fixtures
  # apart: one crank tx can legitimately carry deploy, return, AND expedite
  # legs at once, and picking purely by presence made two fixtures identical
  # (PR #5 review).
  local query="$1" must="$2"; shift 2
  local mustnot_json
  mustnot_json="$(printf '%s\n' "$@" | jq -R . | jq -sc .)"
  curl -sf --get "$RPC/tx_search" \
    --data-urlencode "query=\"$query\"" --data-urlencode 'per_page=50' \
    --data-urlencode 'order_by="desc"' \
    | jq -r --arg must "$must" --argjson mustnot "$mustnot_json" '
        [.result.txs[]
         | [.tx_result.events[].type] as $types
         | select($must == "" or ($types | index($must)))
         | select(all($mustnot[]; . as $ex | $ex == "" or (($types | index($ex)) | not)))
        ][0].hash // empty'
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

  mkdir -p "$OUT"/{msgs,operator,run-epoch,block-events,queries/vault,queries/contract,queries/staking}

  echo "== message + tx-event shapes (LCD /cosmos/tx/v1beta1/txs/{hash}, verbatim)"
  local h_swap_in h_swap_out h_expedite h_deploy h_return
  h_swap_in="$(tx_search "message.action='$MSG_SWAP_IN'")"
  [ -n "$h_swap_in" ] || fail "no $MSG_SWAP_IN tx on chain — run the drills first"
  capture_lcd_tx "$OUT/msgs/swap-in.json" "$h_swap_in"

  h_swap_out="$(tx_search "message.action='$MSG_SWAP_OUT'")"
  [ -n "$h_swap_out" ] || fail "no $MSG_SWAP_OUT tx on chain"
  capture_lcd_tx "$OUT/msgs/swap-out.json" "$h_swap_out"

  echo "== operator action txs (App M6.4 §2.1: enroll -> pay commission -> pay tip)"
  # Selected by the contract's own wasm `action` attribute, so a chain carrying
  # other contracts' executes cannot be mistaken for ours. Each fixture is one
  # MsgExecuteContract tx captured verbatim; the indexer decodes the pay pair
  # (wasm + same-msg_index transfer) from exactly these shapes.
  local h_register h_pay_commission h_pay_tip
  h_register="$(tx_search "wasm.action='$ACT_REGISTER'")"
  [ -n "$h_register" ] || fail "no $ACT_REGISTER execute tx on chain — run infra/devnet/actions/register-validator.sh"
  capture_lcd_tx "$OUT/operator/register-participation.json" "$h_register"

  h_pay_commission="$(tx_search "wasm.action='$ACT_PAY_COMMISSION'")"
  [ -n "$h_pay_commission" ] || fail "no $ACT_PAY_COMMISSION execute tx on chain — run infra/devnet/actions/pay-commission.sh"
  capture_lcd_tx "$OUT/operator/pay-commission.json" "$h_pay_commission"

  h_pay_tip="$(tx_search "wasm.action='$ACT_PAY_TIP'")"
  [ -n "$h_pay_tip" ] || fail "no $ACT_PAY_TIP execute tx on chain — run infra/devnet/actions/pay-tip.sh"
  capture_lcd_tx "$OUT/operator/pay-tip.json" "$h_pay_tip"

  echo "== RunEpoch crank txs (settlement legs + expedite; wasm action attrs)"
  # Each run-epoch fixture pins a DISTINCT crank tx (gate-enforced below):
  # deploy = mint leg without burn/expedite; return = burn leg (an expedite
  # riding along is chain reality and allowed); expedite = expedite WITHOUT a
  # burn leg (the standalone scenario generate-corpus.sh drives).
  h_deploy="$(tx_search_filtered "$EV_PAYMENT_ACCEPTED.target EXISTS" "$EV_MARKER_MINT" "$EV_MARKER_BURN" "$EV_EXPEDITED")"
  [ -n "$h_deploy" ] || fail "no crank tx with a pure deploy settlement (mint + payment, no burn/expedite)"
  capture_lcd_tx "$OUT/run-epoch/deploy-settlement.json" "$h_deploy"

  h_return="$(tx_search_filtered "$EV_PAYMENT_ACCEPTED.target EXISTS" "$EV_MARKER_BURN")"
  [ -n "$h_return" ] || fail "no crank tx with $EV_MARKER_BURN + $EV_PAYMENT_ACCEPTED (return settlement)"
  capture_lcd_tx "$OUT/run-epoch/return-settlement.json" "$h_return"

  h_expedite="$(tx_search_filtered "$EV_EXPEDITED.request_id EXISTS" "" "$EV_MARKER_BURN")"
  [ -n "$h_expedite" ] || fail "no burn-free crank tx carrying $EV_EXPEDITED — run scripts/generate-corpus.sh (standalone expedite scenario)"
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
    --arg image "$(docker image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || echo unknown)" \
    --arg vault "$vault" --arg contract "$contract" \
    --arg tx_swap_in "$h_swap_in" --arg tx_swap_out "$h_swap_out" \
    --arg tx_deploy "$h_deploy" --arg tx_return "$h_return" \
    --arg tx_expedite "$h_expedite" \
    --arg blk_paid "$b_paid" --arg blk_refund "$b_refund" \
    --arg tx_register "$h_register" \
    --arg tx_pay_commission "$h_pay_commission" --arg tx_pay_tip "$h_pay_tip" \
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
        "contract cranks emit plain wasm events with action attributes; epoch snapshot/APR data is read by smart query, not events",
        "contract wasm attribute values are NOT JSON-quoted (unlike vault event values): action/valoper/amount arrive bare — dequote tolerates both, so decoding stays uniform",
        "pay_commission'"'"'s wasm event carries the per-payment amount plus outstanding; pay_tip'"'"'s carries only the epoch-CUMULATIVE tip_epoch — a tip payment'"'"'s own nhash is NOT in the wasm event",
        "an operator payment'"'"'s nhash and payer are read from the same-msg_index bank transfer event (recipient = the contract): the msg'"'"'s attached funds, which cw_utils::must_pay bounds to exactly one coin in the underlying denom"
      ],
      sources: {
        swap_in_tx: $tx_swap_in, swap_out_tx: $tx_swap_out,
        deploy_settlement_tx: $tx_deploy, return_settlement_tx: $tx_return,
        expedite_tx: $tx_expedite,
        payout_block: ($blk_paid|tonumber), refund_block: ($blk_refund|tonumber),
        register_participation_tx: $tx_register,
        pay_commission_tx: $tx_pay_commission, pay_tip_tx: $tx_pay_tip
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

require_absent() { # require_absent <file> <marker> <label>
  local f="$OUT/$1"
  [ -s "$f" ] || return 0 # missing file is reported by its own require line
  ! grep -q "$2" "$f" || MISSING+=("$3 — $1 must NOT contain '$2'")
}

# grep-only txhash extraction (the CI gate container has no jq).
fixture_txhash() { grep -o '"txhash": *"[A-F0-9]*"' "$OUT/$1" 2>/dev/null | head -1; }

# The three run-epoch fixtures must pin three DISTINCT crank txs: one crank
# can carry deploy, return, and expedite legs at once, and presence-only
# selection once committed the same tx under two names (PR #5 review).
require_distinct_cranks() {
  local a b c
  a="$(fixture_txhash run-epoch/deploy-settlement.json)"
  b="$(fixture_txhash run-epoch/return-settlement.json)"
  c="$(fixture_txhash run-epoch/expedite.json)"
  [ -n "$a" ] && [ "$a" = "$b" ] && MISSING+=("deploy-settlement and return-settlement pin the same tx")
  [ -n "$a" ] && [ "$a" = "$c" ] && MISSING+=("deploy-settlement and expedite pin the same tx")
  [ -n "$b" ] && [ "$b" = "$c" ] && MISSING+=("return-settlement and expedite pin the same tx")
  return 0 # a passing (false) comparison above must not become the function's status under set -e
}

check_corpus() {
  echo "== completeness gate (required event inventory)"
  MISSING=()
  require "msgs/swap-in.json"                     "$MSG_SWAP_IN"           "swap in (msg)"
  require "msgs/swap-in.json"                     "$EV_SWAP_IN"            "swap in (event)"
  require "msgs/swap-out.json"                    "$MSG_SWAP_OUT"          "swap out (msg)"
  require "msgs/swap-out.json"                    "$EV_SWAP_OUT_REQUESTED" "enqueue (event)"
  require "run-epoch/deploy-settlement.json"      "$EV_PAYMENT_CREATED"    "RunEpoch deploy settlement (payment created leg)"
  require "run-epoch/deploy-settlement.json"      "$EV_PAYMENT_ACCEPTED"   "RunEpoch deploy settlement (payment accepted leg)"
  require "run-epoch/deploy-settlement.json"      "$EV_ASSET_ACCEPTED"     "RunEpoch deploy settlement (AcceptAsset leg)"
  require "run-epoch/deploy-settlement.json"      "$EV_MARKER_MINT"        "RunEpoch deploy settlement (receipt mint leg)"
  require "run-epoch/return-settlement.json"      "$EV_MARKER_BURN"        "RunEpoch return settlement (burn leg)"
  require "run-epoch/return-settlement.json"      "$EV_ASSET_ACCEPTED"     "RunEpoch return settlement (AcceptAsset leg)"
  require "run-epoch/expedite.json"               "$EV_EXPEDITED"          "expedite"
  require_absent "run-epoch/expedite.json"        "$EV_MARKER_BURN"        "expedite is a standalone (burn-free) crank"
  require_distinct_cranks
  require "operator/register-participation.json"  "$MSG_EXECUTE"           "enroll (msg)"
  require "operator/register-participation.json"  "$ACT_REGISTER"          "enroll (wasm action)"
  require "operator/pay-commission.json"          "$MSG_EXECUTE"           "pay commission (msg)"
  require "operator/pay-commission.json"          "$ACT_PAY_COMMISSION"    "pay commission (wasm action)"
  require "operator/pay-commission.json"          "outstanding"            "pay commission (outstanding attr)"
  require "operator/pay-tip.json"                 "$MSG_EXECUTE"           "pay tip (msg)"
  require "operator/pay-tip.json"                 "$ACT_PAY_TIP"           "pay tip (wasm action)"
  require "operator/pay-tip.json"                 "tip_epoch"              "pay tip (tip_epoch attr)"
  # The funds plane the indexer reads a payment's nhash + payer from. Without a
  # transfer event at the pay msg's index there is NO per-payment amount for a
  # tip, so this is a decode prerequisite, not a nicety.
  require "operator/pay-commission.json"          '"type":"transfer"'      "pay commission (funds transfer event)"
  require "operator/pay-tip.json"                 '"type":"transfer"'      "pay tip (funds transfer event)"
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
