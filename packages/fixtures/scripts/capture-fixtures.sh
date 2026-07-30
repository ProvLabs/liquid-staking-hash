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

# tx_search_attr <cometbft-query> → newest matching txhash. Unlike `tx_search`
# this passes the query THROUGH, so a caller can select on a typed event's
# attribute (e.g. a specific proposal id) instead of on a message action —
# necessary whenever two txs of the same action must land in different fixtures.
tx_search_attr() {
  curl -sf --get "$RPC/tx_search" \
    --data-urlencode "query=\"$1\"" --data-urlencode 'per_page=50' \
    --data-urlencode 'order_by="desc"' \
    | jq -r '.result.txs[0].hash // empty'
}

# tx_search_event <cometbft-query> <event-type> <attr-key> <attr-value> →
# newest matching txhash, filtered CLIENT-SIDE on the event attribute.
#
# Client-side on purpose. x/group's typed events store their string attribute
# values WITH the JSON quotes (`proposal_id` is literally `"15"`), and matching
# that in a CometBFT query means nesting escaped double quotes inside the
# `query="…"` wrapper — which silently produced an empty result rather than an
# error. Filtering here is unambiguous and the page is bounded anyway.
tx_search_event() {
  curl -sf --get "$RPC/tx_search" \
    --data-urlencode "query=\"$1\"" --data-urlencode 'per_page=50' \
    --data-urlencode 'order_by="desc"' \
    | jq -r --arg t "$2" --arg k "$3" --arg v "$4" '
        [.result.txs[]
         | select([.tx_result.events[]
                   | select(.type==$t)
                   | .attributes[]
                   | select(.key==$k and (.value|fromjson? // .) == $v)] | length > 0)
        ][0].hash // empty'
}

# tx_search_multi <cometbft-query> <event-type> <n> → newest tx carrying at
# least <n> events of that type. The multiplicity fixtures need the BATCHED tx
# specifically, and a plain search returns whichever came last.
tx_search_multi() {
  curl -sf --get "$RPC/tx_search" \
    --data-urlencode "query=\"$1\"" --data-urlencode 'per_page=50' \
    --data-urlencode 'order_by="desc"' \
    | jq -r --arg t "$2" --argjson n "$3" '
        [.result.txs[]
         | select(([.tx_result.events[]|select(.type==$t)]|length) >= $n)
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

# --- governance capture (app plan PR 7.1 commit A) --------------------------
#
# A SEPARATE mode, following the M6.4 `partial_captures` precedent already in
# the manifest: the group substrate is bootstrapped onto a devnet the milestone
# is being driven against, and a full corpus regeneration would mean resetting
# that chain. The captured governance shapes therefore record their own
# provenance block rather than pretending to belong to the 2026-07-14 capture.
#
# Everything here is a shape the App decodes. Nothing is synthesized: the
# proposals come from `contracts/drills/gov-drill.sh`, and the drill's
# observation record supplies the pinned facts.
capture_governance() {
  echo "== governance capture (x/group)"
  local chain_id height drill policy fast_policy group_id
  chain_id="$(curl -sf "$RPC/status" | jq -r '.result.node_info.network')"
  height="$(curl -sf "$RPC/status" | jq -r '.result.sync_info.latest_block_height')"

  drill="${GOV_DRILL_RECORD:-$SDIR/../../../contracts/drills/.gov-drill.json}"
  [ -s "$drill" ] || fail "no drill observation record at $drill — run contracts/drills/gov-drill.sh first"
  policy="$(jq -r '.policy' "$drill")"
  fast_policy="$(jq -r '.fast_policy' "$drill")"
  group_id="$(jq -r '.group_id' "$drill")"
  note "chain=$chain_id height=$height group=$group_id policies=$policy,$fast_policy"

  mkdir -p "$OUT/queries/group" "$OUT/governance"

  echo "== group query shapes (LCD, verbatim)"
  capture_lcd "$OUT/queries/group/groups.json"             "cosmos/group/v1/groups"
  capture_lcd "$OUT/queries/group/group-info.json"         "cosmos/group/v1/group_info/$group_id"
  capture_lcd "$OUT/queries/group/group-members.json"      "cosmos/group/v1/group_members/$group_id"
  capture_lcd "$OUT/queries/group/group-policy-info.json"  "cosmos/group/v1/group_policy_info/$policy"
  # The set-valued discovery of M7.1 §2.1 reads BOTH of these; capturing only
  # one would let a decoder pass while handling half the discovery path.
  capture_lcd "$OUT/queries/group/group-policies-by-group.json" "cosmos/group/v1/group_policies_by_group/$group_id"
  capture_lcd "$OUT/queries/group/group-policies-by-admin.json" \
    "cosmos/group/v1/group_policies_by_admin/$(jq -r '.policy' "$drill" >/dev/null; curl -sf "$LCD/cosmos/group/v1/group_info/$group_id" | jq -r '.info.admin')"
  capture_lcd "$OUT/queries/group/proposals-by-group-policy.json" \
    "cosmos/group/v1/proposals_by_group_policy/$fast_policy"
  # A page-limited read, so the corpus contains a REAL `next_key` and the
  # pagination-follow path is exercised by data rather than asserted. A sweep
  # that silently truncates is indistinguishable from a prune (M7.1 §4 inv. 14).
  capture_lcd "$OUT/queries/group/proposals-page-1.json" \
    "cosmos/group/v1/proposals_by_group_policy/$fast_policy?pagination.limit=2"
  local next_key
  next_key="$(jq -r '.pagination.next_key // empty' "$OUT/queries/group/proposals-page-1.json")"
  [ -n "$next_key" ] || fail "proposals-page-1 carries no next_key — the pagination corpus is not a real two-page read"
  capture_lcd "$OUT/queries/group/proposals-page-2.json" \
    "cosmos/group/v1/proposals_by_group_policy/$fast_policy?pagination.limit=2&pagination.key=$(printf %s "$next_key" | jq -sRr @uri)"

  # Per-status reads: ACCEPTED-but-unexecuted and ACCEPTED-with-FAILURE are the
  # two ACCEPTED states a state read can actually see (a SUCCESSFUL exec prunes
  # the proposal in its own transaction — drill phase 1), so both are pinned.
  local p_notrun p_failure p_reject
  p_notrun="$(jq -r '.proposals.accepted_not_run' "$drill")"
  p_failure="$(jq -r '.proposals.exec_failure' "$drill")"
  p_reject="$(jq -r '.proposals.vpe_reject' "$drill")"
  capture_lcd "$OUT/queries/group/proposal-accepted-not-run.json" "cosmos/group/v1/proposal/$p_notrun"
  capture_lcd "$OUT/queries/group/proposal-exec-failure.json"     "cosmos/group/v1/proposal/$p_failure"
  capture_lcd "$OUT/queries/group/proposal-rejected.json"         "cosmos/group/v1/proposal/$p_reject"
  # The MISSING-proposal body. Captured deliberately, and NOT via capture_lcd:
  # the LCD answers HTTP 500 for a proposal it no longer holds, so `curl -sf`
  # would treat the most important shape in this family as a failure. The
  # indexer must recognize this body and must NOT treat any other 500 as a
  # prune (M7.1 §4 invariant 4).
  curl -s "$LCD/cosmos/group/v1/proposal/999999999" > "$OUT/queries/group/proposal-not-found.json" \
    || fail "could not capture the missing-proposal body"
  note "proposal-not-found.json <- LCD 500 body (pruned and never-existing are identical)"
  # Votes: readable while a proposal is OPEN, and EMPTY once its tally is final
  # — the module deletes them at voting-period end (drill phase 3b). Both are
  # captured, because the empty one is what a closed proposal actually returns.
  capture_lcd "$OUT/queries/group/votes-by-proposal-closed.json" "cosmos/group/v1/votes_by_proposal/$p_notrun"

  echo "== governance tx + block shapes"
  local h_submit h_vote h_exec_ok h_exec_fail b_prune p_success
  p_success="$(jq -r '.proposals.success' "$drill")"
  # `tx_search_attr`, not `tx_search`: the latter takes a must/must-not filter
  # list and its `shift 2` aborts under `set -e` when called with one argument.
  h_submit="$(tx_search_attr "message.action='/cosmos.group.v1.MsgSubmitProposal'")"
  h_vote="$(tx_search_attr "message.action='/cosmos.group.v1.MsgVote'")"
  # BOTH exec outcomes, pinned by PROPOSAL ID rather than by recency. A
  # `message.action` search returns whichever exec ran last, which silently
  # picked the FAILURE tx and left the success shape — the one carrying
  # EventProposalPruned — out of the corpus entirely.
  h_exec_ok="$(tx_search_event "message.action='/cosmos.group.v1.MsgExec'" \
    cosmos.group.v1.EventExec proposal_id "$p_success")"
  h_exec_fail="$(tx_search_event "message.action='/cosmos.group.v1.MsgExec'" \
    cosmos.group.v1.EventExec proposal_id "$p_failure")"
  [ -n "$h_submit" ] || fail "no MsgSubmitProposal tx on chain — run contracts/drills/gov-drill.sh"
  [ -n "$h_vote" ]   || fail "no MsgVote tx on chain"
  [ -n "$h_exec_ok" ]   || fail "no MsgExec tx for the drill's SUCCESS proposal ($p_success)"
  [ -n "$h_exec_fail" ] || fail "no MsgExec tx for the drill's FAILURE proposal ($p_failure)"
  capture_lcd_tx "$OUT/governance/submit-proposal.json" "$h_submit"
  capture_lcd_tx "$OUT/governance/vote.json"            "$h_vote"
  capture_lcd_tx "$OUT/governance/exec.json"            "$h_exec_ok"
  capture_lcd_tx "$OUT/governance/exec-failure.json"    "$h_exec_fail"
  # The two-messages-in-one-tx shape. If the tx plane keyed discovery by txhash
  # instead of (txhash, msgIndex), one of these two votes would be lost — the
  # M6.4 batched-payment defect in a new place, so the corpus carries the case.
  local h_batch_vote
  h_batch_vote="$(tx_search_multi "message.action='/cosmos.group.v1.MsgVote'" cosmos.group.v1.EventVote 2)"
  [ -n "$h_batch_vote" ] || fail "no multi-MsgVote tx on chain — run contracts/drills/gov-drill.sh (phase 7b)"
  capture_lcd_tx "$OUT/governance/vote-batched.json" "$h_batch_vote"

  # The EndBlocker plane. The drill scanned its whole height span and found
  # EventProposalPruned there and nothing else — no voting-period-end tally
  # event — so this is the ONE block-plane shape governance has, and the
  # transition itself is observable only through the state sweep.
  local from to h
  from="$(jq -r '.height_span.from' "$drill")"; to="$(jq -r '.height_span.to' "$drill")"
  b_prune=""
  for h in $(seq "$from" "$to"); do
    if curl -sf "$RPC/block_results?height=$h" \
        | jq -e '[.result.finalize_block_events[]?|select(.type=="cosmos.group.v1.EventProposalPruned")]|length > 0' >/dev/null 2>&1; then
      b_prune="$h"; break
    fi
  done
  if [ -n "$b_prune" ]; then
    capture_block_results "$OUT/governance/proposal-pruned-block.json" "$b_prune"
  else
    fail "no EndBlocker EventProposalPruned in the drill's height span — the prune plane has no fixture"
  fi

  echo "== manifest (governance additions)"
  jq \
    --arg captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg chain_id "$chain_id" --arg height "$height" \
    --arg image "$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || echo unknown)" \
    --arg group_id "$group_id" --arg policy "$policy" --arg fast_policy "$fast_policy" \
    --arg tx_submit "$h_submit" --arg tx_vote "$h_vote" \
    --arg tx_exec "$h_exec_ok" --arg tx_exec_fail "$h_exec_fail" \
    --arg tx_vote_batched "$h_batch_vote" \
    --arg blk_prune "$b_prune" \
    --slurpfile drill "$drill" \
    '.pinned_facts += [
       "x/group IS served on this build (LCD /cosmos/group/v1/*); the 2026-07-14 empty groups.json reflected an unbootstrapped devnet, not a missing module",
       "x/group typed-event attribute values are JSON-quoted (proposal_id: \"6\", status, result, logs) while msg_index arrives BARE — the same mixed shape dequote already tolerates",
       "cosmos.group.v1.EventVote carries ONLY proposal_id and msg_index: the voter and the option come from the MsgVote BODY, never from the event",
       "a SUCCESSFULLY executed proposal is pruned in the SAME transaction that executes it, so ACCEPTED+SUCCESS is a pair no state read can ever observe; EventExec.result and EventProposalPruned (status + full tally_result) are its only record",
       "an exec FAILURE leaves the proposal in state as ACCEPTED + FAILURE; a proposal that passes and is not executed sits at ACCEPTED + NOT_RUN",
       "votes are DELETED at the voting-period-end tally even for an ACCEPTED proposal (only final_tally_result survives), so per-voter provenance for any closed proposal exists ONLY in the tx plane",
       "the x/group Vote payload has NO weight field: a voter weight must come from group_members at the vote height, or be null",
       "the LCD answers a missing proposal with HTTP 500 (NOT 404) and a body identical for a pruned and a never-existing id, so prune must be inferred from absence in the paginated sweep or from EventProposalPruned — never from a status code",
       "voting-period-end transitions are EVENTLESS: no tally event appears in finalize_block_events; EventProposalPruned is the only x/group EndBlocker event observed",
       "group_policy_info carries decision_policy INLINE (@type + threshold + windows), so the policy threshold needs no second read",
       "two proposals submitted in one transaction share a submit_time and therefore a voting_period_end, and transition in the SAME block",
       "a multi-proposer proposal needs a signature from every proposer, so one CLI-signed tx cannot create one: `proposers` multiplicity comes from the proto (repeated string), not from this corpus",
       "a second MsgVote from the same voter on the same proposal is REJECTED by the chain, so (proposalId, voter) is a sound natural key (measured, not assumed)",
       "the devnet voting periods (300s admin / 40s ops-fast) and the two-policies-on-one-group topology are DEVNET-ONLY drill affordances, never mainnet facts"
     ]
     # `unique` keeps re-running the capture idempotent. Without it a second run
     # appends the whole fact list again, which is how a manifest quietly grows
     # from 11 pinned facts to 38 and stops being readable as a pin list.
     | .pinned_facts |= unique
     | .sources += {
         gov_submit_proposal_tx: $tx_submit,
         gov_vote_tx: $tx_vote,
         gov_vote_batched_tx: $tx_vote_batched,
         gov_exec_success_tx: $tx_exec,
         gov_exec_failure_tx: $tx_exec_fail,
         gov_proposal_pruned_block: ($blk_prune|tonumber)
       }
     | .governance = {
         group_id: $group_id, policies: [$policy, $fast_policy],
         drill_observations: $drill[0].observations,
         drill_proposals: $drill[0].proposals
       }
     # Replace the entry for this family rather than appending a second one.
     | .partial_captures |= [.[] | select((.files|index("governance/*.json")) == null)]
     | .partial_captures += [{
         files: ["queries/group/*.json", "governance/*.json"],
         reason: "App M7.1 commit A: the x/group substrate was bootstrapped onto the devnet the milestone is being driven against, and a full corpus regeneration would have required resetting that chain (the same tradeoff recorded for the M6.4 operator captures).",
         captured_at: $captured_at, head_height: ($height|tonumber),
         chain_id: $chain_id, node_image: $image,
         chain_instance: "the same devnet instance as the 2026-07-27 operator captures, with a group + two policies added by infra/devnet/bootstrap/nvhash-group-bootstrap.sh and proposals driven by contracts/drills/gov-drill.sh. The contract'"'"'s admin is NOT yet the policy (there is no admin-rotation message — M7 overview F2); a bootstrap with CONTRACT_ADMIN set makes the discovery path live and is the next full-reset capture."
       }]' \
    "$OUT/manifest.json" > "$OUT/manifest.json.tmp" && mv "$OUT/manifest.json.tmp" "$OUT/manifest.json"
  note "manifest.json updated with the governance family"
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
  check_governance_corpus
  if [ "${#MISSING[@]}" -gt 0 ]; then
    echo "CORPUS INCOMPLETE — ${#MISSING[@]} required item(s) missing:" >&2
    printf '  - %s\n' "${MISSING[@]}" >&2
    exit 1
  fi
  echo "ok: corpus complete — all required terminal states present"
}

# The governance family's own inventory (app plan PR 7.1 §4 invariant 17: the
# corpus-completeness gate is standing, and a governance shape that goes missing
# must fail CI rather than degrade a decoder to guessing). Skipped entirely when
# the family has not been captured yet, so this addition does not retroactively
# fail a pre-M7.1 corpus.
check_governance_corpus() {
  [ -s "$OUT/governance/submit-proposal.json" ] || {
    echo "  (governance family not captured — scripts/capture-fixtures.sh --governance)"; return 0; }
  echo "== completeness gate (governance family)"
  require "governance/submit-proposal.json" "cosmos.group.v1.EventSubmitProposal" "submit proposal (event)"
  require "governance/vote.json"            "cosmos.group.v1.EventVote"           "vote (event)"
  # The voter and option are NOT in EventVote — they are read from the message
  # body. Requiring the body's own type URL is what keeps that decode path
  # honest: an event-only fixture would let a decoder that invents the voter pass.
  require "governance/vote.json"            "/cosmos.group.v1.MsgVote"            "vote (message body, the only source of voter+option)"
  require "governance/vote-batched.json"    "/cosmos.group.v1.MsgVote"            "two votes in one tx (the per-msgIndex key case)"
  require "governance/exec.json"            "cosmos.group.v1.EventExec"           "exec (event)"
  require "governance/exec.json"            "PROPOSAL_EXECUTOR_RESULT_SUCCESS"    "exec (SUCCESS result)"
  require "governance/exec.json"            "cosmos.group.v1.EventProposalPruned" "exec prunes in its own tx (the ACCEPTED+SUCCESS record)"
  require "governance/exec-failure.json"    "PROPOSAL_EXECUTOR_RESULT_FAILURE"    "exec (FAILURE result)"
  require_absent "governance/exec-failure.json" "cosmos.group.v1.EventProposalPruned" \
    "a FAILED exec does NOT prune — the proposal survives as ACCEPTED+FAILURE"
  require "governance/proposal-pruned-block.json" "cosmos.group.v1.EventProposalPruned" "EndBlocker prune (block plane)"
  require "queries/group/proposal-accepted-not-run.json" "PROPOSAL_EXECUTOR_RESULT_NOT_RUN" "ACCEPTED but unexecuted"
  require "queries/group/proposal-exec-failure.json"     "PROPOSAL_EXECUTOR_RESULT_FAILURE" "ACCEPTED with a failed execution"
  require "queries/group/proposal-rejected.json"         "PROPOSAL_STATUS_REJECTED"         "REJECTED at voting-period end"
  require "queries/group/proposal-not-found.json"        "not found"                        "the missing-proposal body (500, not 404)"
  require "queries/group/group-policy-info.json"         "ThresholdDecisionPolicy"          "decision policy inline on policy info"
  require "queries/group/group-policies-by-group.json"   "group_policies"                   "policy set by group (set-valued discovery)"
  require "queries/group/proposals-page-1.json"          "next_key"                         "a real two-page read (pagination follow)"
  # A closed proposal's votes are EMPTY because the module deletes them at
  # tally. Pinning the empty shape is the point: it is what the state plane
  # actually returns, and a corpus with only the populated shape would hide it.
  require "queries/group/votes-by-proposal-closed.json"  '"votes":\[\]'                     "votes are gone after the tally"
  local f
  for f in queries/group/group-info.json queries/group/group-members.json \
           queries/group/proposals-by-group-policy.json queries/group/proposals-page-2.json \
           queries/group/group-policies-by-admin.json; do
    [ -s "$OUT/$f" ] || MISSING+=("governance query shape — $f missing/empty")
  done
}

case "$MODE" in
  capture) capture; check_corpus ;;
  --governance) capture_governance; check_corpus ;;
  --check) check_corpus ;;
  *) echo "usage: $0 [--governance|--check]" >&2; exit 1 ;;
esac
