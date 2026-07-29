#!/usr/bin/env bash
# x/group governance drill — the state generator for the App's governance
# surfaces (app plan PR 7.1, app-spec §8.7/§9.1).
#
# WHY A DRILL AND NOT A UNIT TEST. Two independent reasons:
#
#  1. `x/group` transitions a proposal at VOTING-PERIOD END inside the module's
#     EndBlocker, with no transaction in the block. Nothing but a live chain
#     produces that, and the App's whole indexing design turns on capturing it.
#  2. `x/group` PRUNES terminal proposals out of chain state. The indexed mirror
#     is therefore the durable record, and "the chain no longer holds this" is a
#     state the read surfaces must render. Only a live chain can create it.
#
# It also, deliberately, produces MULTIPLICITY and not merely terminal states.
# The M6.4 payments drill produced every terminal payment state and never a
# BATCHED payment, so its fixture corpus could illustrate that PR's assumed
# natural key but never contradict it — and the key was wrong (M7 overview §7.1).
# Phase 7 exists to give this PR's C1 assumptions something that can falsify
# them: two messages in one proposal, two proposals in one transaction, two
# votes in one transaction, two proposals transitioning in one block, and an
# attempted VOTE CHANGE, which is the one assumption `(proposalId, voter)`
# rests on.
#
# Prereqs:
#   - dev node up, tx indexer "kv" (see infra/devnet/)
#   - infra/devnet/bootstrap/nvhash-group-bootstrap.sh completed
#   - for the contract-message phases, the contract's admin must BE the policy
#     (there is no admin-rotation message — M7 overview F2 — so that means a
#     bootstrap with CONTRACT_ADMIN set). Skipped, loudly, when it is not.
#
# Writes an observation record to $OUT (default contracts/drills/.gov-drill.json)
# for `packages/fixtures/scripts/capture-fixtures.sh` to fold into the corpus
# manifest's `pinned_facts`. Every fact in it is OBSERVED, never assumed.
set -euo pipefail

CONTAINER="${CONTAINER:-dev-node}"
CHAIN_ID="${CHAIN_ID:-chain-dev}"
HOME_DIR="${HOME_DIR:-/provenance/nodedev}"
LCD="${LCD:-http://localhost:1317}"
RPC="${RPC:-http://localhost:26657}"
GOV_ADMIN="${GOV_ADMIN:-account-1}"
MEMBER_A="${MEMBER_A:-account-1}"
MEMBER_B="${MEMBER_B:-account-2}"
MEMBER_C="${MEMBER_C:-validator}"
GROUP_METADATA="${GROUP_METADATA:-nvhash-program-governance}"
POLICY_METADATA="${POLICY_METADATA:-nvhash-program-admin}"
FAST_POLICY_METADATA="${FAST_POLICY_METADATA:-nvhash-program-ops-fast}"
# How long to wait for a voting-period-end transition; the fast policy's window
# plus slack. Bounded: a drill that hangs is a drill nobody runs.
VPE_WAIT="${VPE_WAIT:-120}"
# How long to wait for the chain to PRUNE a terminal proposal. x/group prunes at
# `voting_period_end + MaxExecutionPeriod`, and MaxExecutionPeriod is an app-
# wiring constant with no query — so this is a bounded observation, and "not
# observed within the window" is recorded as exactly that.
PRUNE_WAIT="${PRUNE_WAIT:-90}"

SDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-$SDIR/.gov-drill.json}"

pexec() { docker exec "$CONTAINER" provenanced "$@"; }
qj()    { pexec query "$@" -t --home "$HOME_DIR" -o json; }
addr_of() { pexec keys show "$1" -a -t --home "$HOME_DIR" --keyring-backend test 2>/dev/null; }
lcd()   { curl -sf -m 10 "$LCD/$1"; }
lcd_code() { curl -s -m 10 -o /dev/null -w '%{http_code}' "$LCD/$1"; }
head_height() { curl -s -m 10 "$RPC/status" | jq -r '.result.sync_info.latest_block_height'; }
chain_time()  { curl -s -m 10 "$RPC/status" | jq -r '.result.sync_info.latest_block_time'; }
put_file() { docker exec -i "$CONTAINER" sh -c "cat > $1"; }

TXFLAGS="-t --home ${HOME_DIR} --keyring-backend test --chain-id ${CHAIN_ID} --gas auto --gas-adjustment 2.0 --gas-prices 1nhash --broadcast-mode sync -y -o json"

PASS=0; SKIP=0
ok()   { echo "  OK   $*"; PASS=$((PASS+1)); }
fail() { echo "  FAIL $*" >&2; exit 1; }
skip() { echo "  SKIP $*" >&2; SKIP=$((SKIP+1)); }
note() { echo "  ..   $*"; }
assert_eq() { [ "$2" = "$3" ] && ok "$1 = $2" || fail "$1: got '$2', want '$3'"; }

# tx <from-key> -- <subcommand...>  → prints txhash; fails loudly.
tx() {
  local from="$1"; shift; [ "$1" = "--" ] && shift
  local out txhash code res
  out="$(pexec tx "$@" $TXFLAGS --from "$from" 2>/dev/null)" || fail "broadcast failed: $*"
  txhash="$(echo "$out" | jq -r '.txhash // empty')"
  [ -n "$txhash" ] || fail "no txhash: $(echo "$out" | head -c 300)"
  [ "$(echo "$out" | jq -r '.code')" = "0" ] || fail "rejected: $(echo "$out" | jq -r '.raw_log' | head -c 300)"
  for _ in $(seq 1 30); do
    res="$(pexec query tx "$txhash" -t --home "$HOME_DIR" -o json 2>/dev/null || true)"
    code="$(echo "$res" | jq -r '.code // empty' 2>/dev/null || true)"
    [ -n "$code" ] && break; sleep 1
  done
  [ "$code" = "0" ] || fail "tx failed (code=${code:-?}): $(echo "$res" | jq -r '.raw_log // "?"' | head -c 300)"
  echo "$txhash"
}

# broadcast_raw <tx-body-json> <signer-key> → txhash on success, "" on refusal.
# The CLI has no command that builds a MULTI-message transaction, and phase 7
# needs three of them. So the tx body is authored directly and signed with
# `tx sign`. `set -e` is deliberately relaxed: a REFUSAL is an observation here,
# not a drill failure.
broadcast_raw() {
  local body="$1" signer="$2" out
  echo "$body" | put_file /tmp/gov-drill-tx.json
  if ! pexec tx sign /tmp/gov-drill-tx.json --from "$signer" -t --home "$HOME_DIR" \
        --keyring-backend test --chain-id "$CHAIN_ID" \
        --output-document /tmp/gov-drill-tx-signed.json >/dev/null 2>&1; then
    echo ""; return 0
  fi
  out="$(pexec tx broadcast /tmp/gov-drill-tx-signed.json -t --home "$HOME_DIR" \
          --chain-id "$CHAIN_ID" -o json 2>/dev/null || true)"
  if [ "$(echo "$out" | jq -r '.code // 1')" = "0" ]; then
    echo "$out" | jq -r '.txhash'
  else
    echo ""
  fi
}

# A tx envelope around a proto-JSON message array, one signer.
tx_envelope() { # tx_envelope <messages-json-array> [gas] [fee]
  jq -n --argjson messages "$1" --arg gas "${2:-2000000}" --arg fee "${3:-800000000}" \
    '{body:{messages:$messages,memo:"",timeout_height:"0",extension_options:[],non_critical_extension_options:[]},
      auth_info:{signer_infos:[],fee:{amount:[{denom:"nhash",amount:$fee}],gas_limit:$gas,payer:"",granter:""}},
      signatures:[]}'
}

proposal_json() { # proposal_json <policy> <proposers-json-array> <messages-json-array> <title>
  jq -n --arg p "$1" --argjson proposers "$2" --argjson msgs "$3" --arg t "$4" \
    '{"@type":"/cosmos.group.v1.MsgSubmitProposal",group_policy_address:$p,proposers:$proposers,
      metadata:"",messages:$msgs,exec:"EXEC_UNSPECIFIED",title:$t,summary:$t}'
}

send_msg() { # send_msg <from> <to> <amount>
  jq -n --arg f "$1" --arg t "$2" --arg a "$3" \
    '{"@type":"/cosmos.bank.v1beta1.MsgSend",from_address:$f,to_address:$t,amount:[{denom:"nhash",amount:$a}]}'
}

# submit <policy> <messages-json-array> <title> [proposer-key] → proposal id
submit() {
  local policy="$1" msgs="$2" title="$3" pkey="${4:-$MEMBER_A}" paddr
  paddr="$(addr_of "$pkey")"
  proposal_json "$policy" "[\"$paddr\"]" "$msgs" "$title" | jq '[.]' \
    | { read -r -d '' m || true; tx_envelope "$m"; } >/tmp/gov-drill-env.json
  local hash
  hash="$(broadcast_raw "$(cat /tmp/gov-drill-env.json)" "$pkey")"
  [ -n "$hash" ] || fail "submit '$title' was refused"
  await_block
  lcd "cosmos/group/v1/proposals_by_group_policy/$policy" \
    | jq -r --arg t "$title" '[.proposals[]?|select(.title==$t)|.id|tonumber]|max // empty'
}

vote() { # vote <id> <member-key> <YES|NO|ABSTAIN|NO_WITH_VETO> [metadata]
  local id="$1" key="$2" opt="$3" meta="${4:-drill}" addr
  addr="$(addr_of "$key")"
  tx "$key" -- group vote "$id" "$addr" "VOTE_OPTION_$opt" "$meta" >/dev/null
}

await_block() { local h; h="$(head_height)"; while [ "$(head_height)" = "$h" ]; do sleep 1; done; }

# --- reading a proposal that may no longer exist --------------------------
#
# OBSERVED 2026-07-29, and it contradicts the plan's §2.2/§4-invariant-4 wording:
# the LCD answers a MISSING proposal with **HTTP 500**, not 404 —
#   {"code":2, "message":"codespace sdk code 38: not found: load proposal"}
# — and the answer is BYTE-IDENTICAL for a proposal that was pruned and one that
# never existed. So an HTTP status can never justify writing `prunedAtHeight`: a
# node error, a wrong height pin, and a genuine prune all arrive as 500.
#
# `proposal_state` therefore reports three OUTCOMES, not two, and the indexer
# must draw the same distinction:
#   PRESENT   — a proposal body came back
#   ABSENT    — 500 whose body says "not found" (pruned, or never existed)
#   UNREADABLE— anything else: a read failure, which must write NOTHING
proposal_state() {
  local code body
  body="$(curl -s -m 10 -w '\n%{http_code}' "$LCD/cosmos/group/v1/proposal/$1")"
  code="$(echo "$body" | tail -1)"; body="$(echo "$body" | sed '$d')"
  if [ "$code" = "200" ]; then echo "PRESENT"; return 0; fi
  if echo "$body" | grep -q 'not found'; then echo "ABSENT"; return 0; fi
  echo "UNREADABLE"
}

# proposal_field <id> <jq-path> → value, or ABSENT/UNREADABLE
proposal_field() {
  local st
  st="$(proposal_state "$1")"
  [ "$st" = "PRESENT" ] || { echo "$st"; return 0; }
  lcd "cosmos/group/v1/proposal/$1" | jq -r ".proposal.$2 // empty"
}

# wait_status <id> <want-status-suffix|ABSENT> <seconds> → 0 on reach
wait_status() {
  local id="$1" want="$2" secs="$3" got
  for _ in $(seq 1 "$secs"); do
    got="$(status_of "$id")"
    [ "$got" = "$want" ] && return 0
    sleep 1
  done
  return 1
}

status_of() {
  local s; s="$(proposal_field "$1" status)"
  case "$s" in ABSENT|UNREADABLE) echo "$s" ;; *) echo "${s#PROPOSAL_STATUS_}" ;; esac
}
exec_of() {
  local s; s="$(proposal_field "$1" executor_result)"
  case "$s" in ABSENT|UNREADABLE) echo "$s" ;; *) echo "${s#PROPOSAL_EXECUTOR_RESULT_}" ;; esac
}

# group_event_attr <txhash> <event-type> <attr-key> → dequoted attribute value.
# x/group's typed events JSON-QUOTE their string attribute values
# (`proposal_id: "6"`) but NOT `msg_index` (`0`), exactly like the vault/contract
# split the corpus already pins — so `dequote` stays the one decoding idiom.
group_event_attr() {
  pexec query tx "$1" -t --home "$HOME_DIR" -o json 2>/dev/null \
    | jq -r --arg t "$2" --arg k "$3" \
      '[.events[]|select(.type==$t)|.attributes[]|select(.key==$k)|.value]|first // empty' \
    | sed 's/^"//; s/"$//'
}

# group_events_at <height> → compact JSON array of x/group EndBlocker event types
group_events_at() {
  curl -s -m 10 "$RPC/block_results?height=$1" \
    | jq -c '[.result.finalize_block_events[]?|select(.type|startswith("cosmos.group."))|.type]'
}

# group_txs_at <height> → count of txs at that height carrying an x/group message
group_txs_at() {
  curl -s -m 10 "$RPC/block_results?height=$1" \
    | jq '[.result.txs_results[]?.events[]?|select(.type|startswith("cosmos.group."))]|length'
}

DRILL_START_HEIGHT="$(head_height)"
echo "== gov-drill: start height $DRILL_START_HEIGHT, chain time $(chain_time) =="

# ===========================================================================
echo; echo "########## 0/9  SUBSTRATE — the policy SET, never 'the' policy ##########"
# ===========================================================================
ADMIN_ADDR="$(addr_of "$GOV_ADMIN")"
GROUP_ID="$(qj group groups-by-admin "$ADMIN_ADDR" | jq -r --arg m "$GROUP_METADATA" \
  '.groups[]?|select(.metadata==$m)|.id' | head -1)"
[ -n "$GROUP_ID" ] || fail "no group '$GROUP_METADATA' — run infra/devnet/bootstrap/nvhash-group-bootstrap.sh"

POLICIES_JSON="$(lcd "cosmos/group/v1/group_policies_by_group/$GROUP_ID")"
POLICY_COUNT="$(echo "$POLICIES_JSON" | jq '.group_policies|length')"
POLICY="$(echo "$POLICIES_JSON" | jq -r --arg m "$POLICY_METADATA" '.group_policies[]|select(.metadata==$m)|.address')"
FAST_POLICY="$(echo "$POLICIES_JSON" | jq -r --arg m "$FAST_POLICY_METADATA" '.group_policies[]|select(.metadata==$m)|.address')"
[ -n "$POLICY" ] || fail "no '$POLICY_METADATA' policy on group $GROUP_ID"
[ -n "$FAST_POLICY" ] || fail "no '$FAST_POLICY_METADATA' policy on group $GROUP_ID"

TOTAL_WEIGHT="$(lcd "cosmos/group/v1/group_info/$GROUP_ID" | jq -r '.info.total_weight')"
MEMBER_COUNT="$(lcd "cosmos/group/v1/group_members/$GROUP_ID" | jq '.members|length')"
THRESHOLD="$(echo "$POLICIES_JSON" | jq -r --arg m "$POLICY_METADATA" \
  '.group_policies[]|select(.metadata==$m)|.decision_policy.threshold')"

note "group $GROUP_ID, admin $ADMIN_ADDR, members $MEMBER_COUNT, total weight $TOTAL_WEIGHT"
note "policies discovered: $POLICY_COUNT"
# The point of this assertion: a corpus with exactly one policy cannot
# distinguish "handles the set" from "happens to take the first element".
[ "$POLICY_COUNT" -ge 2 ] && ok "policy set has $POLICY_COUNT members (the 1..n case is REAL in the corpus)" \
  || fail "expected >= 2 policies on the group so the set-valued discovery of \
plan §2.1 is exercised by data, not by claim; got $POLICY_COUNT"
[ "$THRESHOLD" -lt "$TOTAL_WEIGHT" ] && ok "threshold $THRESHOLD < total weight $TOTAL_WEIGHT (a proposal can fail)" \
  || fail "threshold $THRESHOLD is not below total weight $TOTAL_WEIGHT — no proposal could ever be rejected on votes"

# Is the contract admin the policy? Recorded either way; the contract phases
# need it, and there is no admin-rotation message to make it true here (F2).
CONTRACT="$(qj vault list 2>/dev/null | jq -r '.vaults[]?|select(.total_shares.denom=="nvhash")|.base_account.address' | head -1)"
[ -n "${CONTRACT:-}" ] && [ "$CONTRACT" != "null" ] \
  && CONTRACT="$(qj vault get "$CONTRACT" 2>/dev/null | jq -r '.vault.asset_manager // empty')" || CONTRACT=""
CONTRACT_ADMIN_IS_POLICY=false
if [ -n "$CONTRACT" ]; then
  CUR="$(qj wasm contract-state smart "$CONTRACT" '{"config":{}}' 2>/dev/null | jq -r '.data.admin // empty')"
  [ "$CUR" = "$POLICY" ] && CONTRACT_ADMIN_IS_POLICY=true
  note "contract $CONTRACT admin=$CUR  (is policy: $CONTRACT_ADMIN_IS_POLICY)"
fi

MEMBER_B_ADDR="$(addr_of "$MEMBER_B")"

# ===========================================================================
echo; echo "########## 1/9  ACCEPTED -> EXEC -> SUCCESS (and TWO messages) ##########"
# ===========================================================================
# Two messages in one proposal is the C1 `messages` multiplicity case, folded
# into the success path so the corpus's canonical happy proposal is ALREADY the
# N>1 shape. A one-message happy path plus a separate two-message oddity would
# let a decoder pass on the common case and break on the real one.
# When the contract's admin IS this policy, the second message is a real
# admin-gated CONTRACT call rather than a second bank send. That matters beyond
# realism: `MsgExecuteContract` inside a proposal is exactly the payload PR 7.4's
# template guard has to canonically re-encode byte-for-byte, and app-spec §14.6
# routes every admin program-op through this shape. A corpus of bank sends would
# not exercise it at all.
# `msg` is an INLINE JSON OBJECT, not base64: cosmwasm's `RawContractMessage`
# embeds the payload verbatim rather than proto-JSON base64-encoding the `bytes`
# field. Base64 is accepted silently and then handed to the contract as the
# message itself (observed 2026-07-29: "unknown variant `eyJ1cGRhdGVfY29uZmln…`").
contract_exec_msg() { # contract_exec_msg <execute-json>
  jq -n --arg s "$POLICY" --arg c "$CONTRACT" --argjson m "$1" \
    '{"@type":"/cosmwasm.wasm.v1.MsgExecuteContract",sender:$s,contract:$c,msg:$m,funds:[]}'
}
if [ "$CONTRACT_ADMIN_IS_POLICY" = "true" ]; then
  # `set_halted false` is the benign, idempotent admin call: it asserts the
  # program's normal state rather than changing behavior, so a drill can run it
  # repeatedly without leaving the chain halted.
  MSGS_TWO="[$(send_msg "$POLICY" "$MEMBER_B_ADDR" 1000),$(contract_exec_msg '{"set_halted":{"halted":false}}')]"
  note "second message is a real admin-gated MsgExecuteContract (the §14.6 shape)"
else
  MSGS_TWO="[$(send_msg "$POLICY" "$MEMBER_B_ADDR" 1000),$(send_msg "$POLICY" "$MEMBER_B_ADDR" 2000)]"
  skip "contract admin is not this policy — the proposal carries bank sends, not the §14.6 contract shape"
fi
P_OK="$(submit "$POLICY" "$MSGS_TWO" "drill-success")"
note "proposal $P_OK submitted (2 messages)"
assert_eq "proposal $P_OK messages" "$(lcd "cosmos/group/v1/proposal/$P_OK" | jq '.proposal.messages|length')" "2"

vote "$P_OK" "$MEMBER_A" YES
vote "$P_OK" "$MEMBER_B" YES
await_block
VOTES_OPEN="$(lcd "cosmos/group/v1/votes_by_proposal/$P_OK" | jq '.votes|length')"
assert_eq "votes readable while OPEN" "$VOTES_OPEN" "2"
# Every option must appear somewhere in the corpus; abstain rides here, where it
# cannot change the outcome (threshold is on YES weight).
vote "$P_OK" "$MEMBER_C" ABSTAIN
await_block
assert_eq "proposal $P_OK before exec" "$(status_of "$P_OK")" "SUBMITTED"

EXEC_HASH="$(tx "$MEMBER_A" -- group exec "$P_OK")"
await_block

# OBSERVED 2026-07-29, and it contradicts the plan's §2.2 assumption that the
# height-pinned state sweep is the authority for every proposal's outcome:
# x/group PRUNES a successfully executed proposal in the SAME TRANSACTION that
# executes it. So `ACCEPTED` + `SUCCESS` is a state pair the sweep can NEVER
# observe — the happy path is precisely the path that leaves nothing behind.
#
# The outcome is recoverable, but only from the tx plane: `EventExec` carries
# `result`, and `EventProposalPruned` carries BOTH the terminal `status` and the
# full `tally_result`. That is why this phase asserts against the transaction's
# events and not against a read-back.
EXEC_RESULT="$(group_event_attr "$EXEC_HASH" cosmos.group.v1.EventExec result)"
PRUNED_STATUS="$(group_event_attr "$EXEC_HASH" cosmos.group.v1.EventProposalPruned status)"
PRUNED_TALLY="$(group_event_attr "$EXEC_HASH" cosmos.group.v1.EventProposalPruned tally_result)"
assert_eq "EventExec.result for $P_OK" "$EXEC_RESULT" "PROPOSAL_EXECUTOR_RESULT_SUCCESS"
assert_eq "EventProposalPruned.status for $P_OK" "$PRUNED_STATUS" "PROPOSAL_STATUS_ACCEPTED"
[ -n "$PRUNED_TALLY" ] && ok "EventProposalPruned carries the final tally: $PRUNED_TALLY" \
  || fail "EventProposalPruned carried no tally_result — a pruned proposal's tally would be unrecoverable"
assert_eq "proposal $P_OK in chain state after a SUCCESSFUL exec" "$(proposal_state "$P_OK")" "ABSENT"
EXEC_SUCCESS_PRUNES_IMMEDIATELY=true

# Are votes still readable after the tally is final? Load-bearing: if the module
# drops votes at tally, the durable record of WHO voted is the tx plane alone,
# and the state plane can never recover a closed proposal's votes. Measured in
# phase 3b against a proposal that survives its own tally — this one is gone.
VOTES_AFTER_TALLY="(not measurable here: the proposal was pruned by its own exec)"

# ===========================================================================
echo; echo "########## 2/9  ACCEPTED -> EXEC -> FAILURE ##########"
# ===========================================================================
# `status` alone cannot express "passed, then the messages failed". That is
# exactly what an administrator needs to see, and exactly why the mirror stores
# `executorResult` beside `status` (plan §3.2).
POLICY_BAL="$(lcd "cosmos/bank/v1beta1/balances/$POLICY" | jq -r '.balances[]?|select(.denom=="nhash")|.amount // "0"')"
OVER="$(( ${POLICY_BAL:-0} + 1000000000 ))"
P_FAIL="$(submit "$POLICY" "[$(send_msg "$POLICY" "$MEMBER_B_ADDR" "$OVER")]" "drill-exec-failure")"
note "proposal $P_FAIL sends ${OVER}nhash from a policy holding ${POLICY_BAL:-0}"
vote "$P_FAIL" "$MEMBER_A" YES
vote "$P_FAIL" "$MEMBER_B" YES
await_block
# MsgExec itself COMMITS — the wrapped failure lands in executor_result, not in
# the tx code. A drill that only checked the tx code would call this a success.
tx "$MEMBER_A" -- group exec "$P_FAIL" >/dev/null
await_block
assert_eq "proposal $P_FAIL status" "$(status_of "$P_FAIL")" "ACCEPTED"
assert_eq "proposal $P_FAIL executor_result" "$(exec_of "$P_FAIL")" "FAILURE"

# ===========================================================================
echo; echo "########## 3/9  REJECTED at voting-period end, in a TXLESS block ##########"
# ===========================================================================
# The transition the entire indexing design turns on. No transaction causes it,
# so no event stream carries it unless the module emits one — which phase 8
# checks rather than assumes.
# 3b, first — ACCEPTED but NOT EXECUTED. The one ACCEPTED state a read CAN see
# (phase 1 proved the executed one prunes itself), and the state the §8.7 UI has
# to offer an "execute" affordance on. It also measures vote survival across the
# tally, on a proposal that outlives its own tally.
P_NOTRUN="$(submit "$FAST_POLICY" "[$(send_msg "$FAST_POLICY" "$MEMBER_B_ADDR" 400)]" "drill-accepted-not-run")"
vote "$P_NOTRUN" "$MEMBER_A" YES
vote "$P_NOTRUN" "$MEMBER_B" YES
await_block
NOTRUN_VOTES_OPEN="$(lcd "cosmos/group/v1/votes_by_proposal/$P_NOTRUN" | jq '.votes|length')"
note "waiting out the fast policy's voting period without executing (up to ${VPE_WAIT}s)…"
wait_status "$P_NOTRUN" ACCEPTED "$VPE_WAIT" || fail "proposal $P_NOTRUN never reached ACCEPTED"
assert_eq "proposal $P_NOTRUN executor_result" "$(exec_of "$P_NOTRUN")" "NOT_RUN"
assert_eq "proposal $P_NOTRUN final tally yes_count" "$(proposal_field "$P_NOTRUN" final_tally_result.yes_count)" "2"

# OBSERVED 2026-07-29, and it is the strongest justification in this PR for
# `gov_votes` existing at all: the module DELETES the votes at the
# voting-period-end tally, for an ACCEPTED proposal, keeping only the aggregate
# in `final_tally_result`. Per-voter history is therefore recoverable ONLY from
# the tx plane once a proposal closes — and a mirror that were built on the state
# sweep alone would show a passed proposal with nobody having voted for it.
VOTES_AFTER_TALLY="$(lcd "cosmos/group/v1/votes_by_proposal/$P_NOTRUN" | jq '.votes|length')"
assert_eq "votes readable AFTER the tally (was $NOTRUN_VOTES_OPEN while open)" "$VOTES_AFTER_TALLY" "0"
note "     -> per-voter provenance for a closed proposal exists ONLY in the tx plane"

P_REJ="$(submit "$FAST_POLICY" "[$(send_msg "$FAST_POLICY" "$MEMBER_B_ADDR" 500)]" "drill-vpe-reject")"
vote "$P_REJ" "$MEMBER_A" NO_WITH_VETO   # the fourth option, and it cannot pass
H_BEFORE="$(head_height)"
assert_eq "proposal $P_REJ before VPE" "$(status_of "$P_REJ")" "SUBMITTED"
note "waiting out the fast policy's voting period (up to ${VPE_WAIT}s)…"
wait_status "$P_REJ" REJECTED "$VPE_WAIT" || fail "proposal $P_REJ never reached REJECTED within ${VPE_WAIT}s"
H_AFTER="$(head_height)"
ok "proposal $P_REJ SUBMITTED -> REJECTED with no transaction of ours"

# Prove it: at least one height in the transition span carried ZERO x/group txs.
TXLESS=0
for h in $(seq "$H_BEFORE" "$H_AFTER"); do
  [ "$(group_txs_at "$h")" = "0" ] && TXLESS=$((TXLESS+1))
done
[ "$TXLESS" -gt 0 ] && ok "$TXLESS of $((H_AFTER-H_BEFORE+1)) heights in the transition span carry no x/group tx" \
  || fail "every height in the span carried an x/group tx — the txless transition was not demonstrated"

# ===========================================================================
echo; echo "########## 4/9  ABORTED by a mid-vote group change ##########"
# ===========================================================================
# `groupVersion`/`groupPolicyVersion` exist so the UI can EXPLAIN an abort
# rather than merely assert it. Without a real abort in the corpus, that claim
# is untested.
P_ABORT="$(submit "$FAST_POLICY" "[$(send_msg "$FAST_POLICY" "$MEMBER_B_ADDR" 600)]" "drill-abort")"
GV_AT_SUBMIT="$(proposal_field "$P_ABORT" group_version)"
vote "$P_ABORT" "$MEMBER_A" YES
vote "$P_ABORT" "$MEMBER_B" YES   # would otherwise pass — the abort overrides a winning tally
# Bump the group version: re-set an existing member to the same weight. The
# member set is unchanged; only `version` moves, which is precisely the
# distinction the UI has to draw.
put_file /tmp/gov-drill-members.json <<JSON
{"members":[{"address":"$MEMBER_B_ADDR","weight":"1","metadata":"$MEMBER_B"}]}
JSON
tx "$GOV_ADMIN" -- group update-group-members "$ADMIN_ADDR" "$GROUP_ID" /tmp/gov-drill-members.json >/dev/null
await_block
GV_NOW="$(lcd "cosmos/group/v1/group_info/$GROUP_ID" | jq -r '.info.version')"
[ "$GV_NOW" != "$GV_AT_SUBMIT" ] && ok "group version moved $GV_AT_SUBMIT -> $GV_NOW while proposal $P_ABORT was open" \
  || fail "group version did not change; the abort case cannot be produced"

note "waiting out the voting period (up to ${VPE_WAIT}s)…"
ABORT_OUTCOME=""
if wait_status "$P_ABORT" ABORTED "$VPE_WAIT"; then
  ABORT_OUTCOME=ABORTED; ok "proposal $P_ABORT ABORTED despite a winning tally"
elif wait_status "$P_ABORT" ABSENT 5; then
  # ABORTED is pruned in the SAME EndBlocker pass on some builds, so the status
  # is never observable through a state read. That is not a drill failure — it
  # is the strongest possible argument for the durable mirror.
  ABORT_OUTCOME=PRUNED_BEFORE_OBSERVABLE
  ok "proposal $P_ABORT was pruned in the same pass that aborted it (status never observable from state)"
else
  # OBSERVED 2026-07-29: on this build a group-membership change does NOT abort
  # an open proposal. Proposal 13 executed SUCCESSFULLY at group_version 1
  # against a group already at version 2, so the exec-time version guard the
  # ABORTED status exists for is not enforced here.
  #
  # This is recorded, not failed, and the distinction matters:
  #   - `PROPOSAL_STATUS_ABORTED` is in the module's proto, so the mirror's
  #     status enum MUST accept it and 7.2 MUST render it — multiplicity comes
  #     from the producing system, never from what the drill can reach (C1).
  #   - but it is NOT in this corpus, so any 7.2 rendering of it is unexercised
  #     by real data. That is a forward obligation on 7.2's C4 matrix, and it is
  #     written down here rather than discovered later.
  ABORT_OUTCOME="not-reachable-on-this-build:$(status_of "$P_ABORT")"
  skip "a mid-vote group change did NOT abort proposal $P_ABORT (reached $(status_of "$P_ABORT"))"
  note "     -> ABORTED stays in the status enum (it is in the proto) but is ABSENT from the corpus"
  note "     -> 7.2 must treat its ABORTED rendering as unexercised by drill data"
fi

# ===========================================================================
echo; echo "########## 5/9  WITHDRAWN by the proposer ##########"
# ===========================================================================
P_WD="$(submit "$FAST_POLICY" "[$(send_msg "$FAST_POLICY" "$MEMBER_B_ADDR" 700)]" "drill-withdraw")"
tx "$MEMBER_A" -- group withdraw-proposal "$P_WD" "$(addr_of "$MEMBER_A")" >/dev/null
await_block
assert_eq "proposal $P_WD status" "$(status_of "$P_WD")" "WITHDRAWN"

# ===========================================================================
echo; echo "########## 6/9  PRUNED — the chain drops what the mirror keeps ##########"
# ===========================================================================
# A WITHDRAWN proposal is pruned when its voting period ends. Bounded wait: the
# module's MaxExecutionPeriod is an app-wiring constant with no query, so "not
# observed in the window" is a legitimate, recorded outcome rather than a
# failure — and the App's behavior on a 404 is unit-tested regardless.
# Phase 1 already observed a prune (a successful exec prunes in its own tx), so
# the durable-mirror case is proven regardless of what happens here. This phase
# adds the OTHER prune route — the EndBlocker one, at
# `voting_period_end + MaxExecutionPeriod` — because that one arrives with no
# transaction at all, and the two are distinguishable to the indexer only by
# whether an `EventProposalPruned` accompanies them.
note "waiting for the EndBlocker to prune proposal $P_WD (up to ${PRUNE_WAIT}s)…"
PRUNE_OBSERVED="$EXEC_SUCCESS_PRUNES_IMMEDIATELY"
ENDBLOCKER_PRUNE_OBSERVED=false
if wait_status "$P_WD" ABSENT "$PRUNE_WAIT"; then
  ENDBLOCKER_PRUNE_OBSERVED=true
  ok "proposal $P_WD is GONE from chain state without a transaction of ours"
  assert_eq "votes of pruned proposal $P_WD" \
    "$(lcd "cosmos/group/v1/votes_by_proposal/$P_WD" | jq '.votes|length')" "0"
elif [ "$ABORT_OUTCOME" = "PRUNED_BEFORE_OBSERVABLE" ]; then
  ENDBLOCKER_PRUNE_OBSERVED=true
  ok "EndBlocker prune observed on proposal $P_ABORT (phase 4)"
else
  skip "no EndBlocker prune within ${PRUNE_WAIT}s — MaxExecutionPeriod on this build exceeds the drill window"
fi

# THE DISTINCTION THAT MATTERS (plan §4 invariant 4's disproof, and it is a live
# hazard rather than a hypothetical one). A missing proposal answers HTTP 500,
# and the body is identical whether it was pruned or never existed. An LCD
# outage or a bad height pin ALSO answers 500. So an unreadable single-proposal
# read must never be written as `prunedAtHeight` — it must be indistinguishable
# from "we could not read the chain", which is what the indexer's
# absent-from-the-authoritative-sweep rule enforces instead.
MISSING_BODY="$(curl -s -m 10 "$LCD/cosmos/group/v1/proposal/$P_WD")"
NEVER_BODY="$(curl -s -m 10 "$LCD/cosmos/group/v1/proposal/999999999")"
assert_eq "a pruned proposal and a never-existing one are byte-identical at the LCD" \
  "$(echo "$MISSING_BODY" | jq -S -c .)" "$(echo "$NEVER_BODY" | jq -S -c .)"
assert_eq "the missing-proposal HTTP status is NOT 404" \
  "$(lcd_code "cosmos/group/v1/proposal/999999999")" "500"
note "     -> prune is inferred from ABSENCE IN THE PAGINATED SWEEP or from"
note "        EventProposalPruned; never from an HTTP status (plan §2.2 amended)"

# ===========================================================================
echo; echo "########## 7/9  MULTIPLICITY — the cases that can falsify the keys ##########"
# ===========================================================================

# 7a — two proposals in ONE transaction. Their submit_time is identical, so
# their voting periods end in the SAME BLOCK: the "proposals transitioning per
# block > 1" case, plus "group messages per tx > 1" at msg_index 0 and 1.
TWIN_A="$(proposal_json "$FAST_POLICY" "[\"$(addr_of "$MEMBER_A")\"]" "[$(send_msg "$FAST_POLICY" "$MEMBER_B_ADDR" 801)]" "drill-twin-a")"
TWIN_B="$(proposal_json "$FAST_POLICY" "[\"$(addr_of "$MEMBER_A")\"]" "[$(send_msg "$FAST_POLICY" "$MEMBER_B_ADDR" 802)]" "drill-twin-b")"
TWIN_HASH="$(broadcast_raw "$(tx_envelope "[$TWIN_A,$TWIN_B]" 3000000 1200000000)" "$MEMBER_A")"
[ -n "$TWIN_HASH" ] || fail "two-proposals-in-one-tx was refused; the same-block transition case cannot be produced"
await_block
P_TWIN_A="$(lcd "cosmos/group/v1/proposals_by_group_policy/$FAST_POLICY" | jq -r '[.proposals[]?|select(.title=="drill-twin-a")|.id]|last // empty')"
P_TWIN_B="$(lcd "cosmos/group/v1/proposals_by_group_policy/$FAST_POLICY" | jq -r '[.proposals[]?|select(.title=="drill-twin-b")|.id]|last // empty')"
[ -n "$P_TWIN_A" ] && [ -n "$P_TWIN_B" ] || fail "could not resolve the twin proposals"
assert_eq "twins share a voting_period_end" \
  "$(proposal_field "$P_TWIN_A" voting_period_end)" "$(proposal_field "$P_TWIN_B" voting_period_end)"
TWIN_MSG_IDX="$(pexec query tx "$TWIN_HASH" -t --home "$HOME_DIR" -o json 2>/dev/null \
  | jq -c '[.events[]|select(.type=="cosmos.group.v1.EventSubmitProposal")|.attributes[]|select(.key=="msg_index")|.value]')"
assert_eq "one tx, two EventSubmitProposal msg_index values" "$TWIN_MSG_IDX" '["0","1"]'

# 7b — one transaction carrying TWO MsgVotes for DIFFERENT proposals. If the tx
# plane keyed discovery by txhash instead of (txhash, msgIndex), one of these
# two votes would be silently lost — the M6.4 defect, exactly.
VOTE_MULTI="[$(jq -n --arg id "$P_TWIN_A" --arg v "$(addr_of "$MEMBER_A")" \
    '{"@type":"/cosmos.group.v1.MsgVote",proposal_id:$id,voter:$v,option:"VOTE_OPTION_YES",metadata:"batch-0",exec:"EXEC_UNSPECIFIED"}'),\
$(jq -n --arg id "$P_TWIN_B" --arg v "$(addr_of "$MEMBER_A")" \
    '{"@type":"/cosmos.group.v1.MsgVote",proposal_id:$id,voter:$v,option:"VOTE_OPTION_YES",metadata:"batch-1",exec:"EXEC_UNSPECIFIED"}')]"
BATCH_VOTE_HASH="$(broadcast_raw "$(tx_envelope "$VOTE_MULTI")" "$MEMBER_A")"
BATCH_VOTE_OK=false
if [ -n "$BATCH_VOTE_HASH" ]; then
  await_block
  BATCH_IDX="$(pexec query tx "$BATCH_VOTE_HASH" -t --home "$HOME_DIR" -o json 2>/dev/null \
    | jq -c '[.events[]|select(.type=="cosmos.group.v1.EventVote")|.attributes[]|select(.key=="msg_index")|.value]')"
  BATCH_VOTE_OK=true
  assert_eq "one tx, two EventVote msg_index values" "$BATCH_IDX" '["0","1"]'
else
  fail "two-MsgVotes-in-one-tx was refused; the per-msgIndex discovery key is untested"
fi

# 7c — TWO PROPOSERS. x/group's proto is `repeated string proposers`, and every
# listed proposer is a required signer, so a multi-proposer proposal needs a
# multi-signer transaction. The CLI cannot build one. The outcome is RECORDED
# either way, because C1 sources multiplicity from the MODULE'S OWN RULES, not
# from what the drill can produce: `proposers` is an array in the proto, so it
# is an array in the mirror whether or not this line succeeds.
TWO_PROPOSER="$(proposal_json "$FAST_POLICY" \
  "[\"$(addr_of "$MEMBER_A")\",\"$MEMBER_B_ADDR\"]" \
  "[$(send_msg "$FAST_POLICY" "$MEMBER_B_ADDR" 900)]" "drill-two-proposers")"
TWO_PROPOSER_HASH="$(broadcast_raw "$(tx_envelope "[$TWO_PROPOSER]")" "$MEMBER_A")"
TWO_PROPOSER_RESULT="refused-single-signature"
if [ -n "$TWO_PROPOSER_HASH" ]; then
  await_block
  P_TWO="$(lcd "cosmos/group/v1/proposals_by_group_policy/$FAST_POLICY" | jq -r '[.proposals[]?|select(.title=="drill-two-proposers")|.id]|last // empty')"
  if [ -n "$P_TWO" ]; then
    N="$(lcd "cosmos/group/v1/proposal/$P_TWO" | jq '.proposal.proposers|length')"
    TWO_PROPOSER_RESULT="accepted-$N-proposers"
    [ "$N" = "2" ] && ok "proposal $P_TWO carries 2 proposers (the N>1 case is IN the corpus)" \
      || note "proposal $P_TWO carries $N proposers"
  fi
else
  note "a 2-proposer proposal signed by ONE proposer was refused, as the module requires"
  note "     -> multiplicity for \`proposers\` comes from the proto (repeated string), not from this corpus"
fi

# 7d — VOTE CHANGE. This is the disproof for the `(proposalId, voter)` natural
# key (plan §4b C1). If the chain accepts a second vote from the same voter, the
# key is lossy in exactly the way `(txhash, msgIndex)` was lossy for batched
# payments in M6.4 — and it must gain a discriminator BEFORE commit B is
# written. Belief is what produced that defect, so this is measured.
P_CHANGE="$(submit "$POLICY" "[$(send_msg "$POLICY" "$MEMBER_B_ADDR" 950)]" "drill-vote-change")"
vote "$P_CHANGE" "$MEMBER_A" YES
await_block
VOTE_CHANGE_ACCEPTED=false
CHANGE_ADDR="$(addr_of "$MEMBER_A")"
if pexec tx group vote "$P_CHANGE" "$CHANGE_ADDR" VOTE_OPTION_NO changed \
      $TXFLAGS --from "$MEMBER_A" 2>/dev/null | jq -e '.code == 0' >/dev/null 2>&1; then
  await_block
  N_VOTES="$(lcd "cosmos/group/v1/votes_by_proposal/$P_CHANGE" | jq '.votes|length')"
  CUR_OPT="$(lcd "cosmos/group/v1/votes_by_proposal/$P_CHANGE" | jq -r --arg v "$CHANGE_ADDR" '.votes[]|select(.voter==$v)|.option')"
  if [ "$N_VOTES" = "1" ]; then
    VOTE_CHANGE_ACCEPTED=replaced
    ok "vote change ACCEPTED and REPLACED the row (1 vote, now $CUR_OPT) — (proposalId, voter) survives as a key"
  else
    VOTE_CHANGE_ACCEPTED=appended
    fail "vote change APPENDED ($N_VOTES votes for one voter): (proposalId, voter) is LOSSY. \
Add a discriminator to GovVote's key BEFORE writing commit B (plan §4b C1)."
  fi
else
  VOTE_CHANGE_ACCEPTED=rejected
  ok "vote change REJECTED by the chain — one vote per (proposal, voter) holds"
fi

# 7e — PAGINATION. `proposals_by_group_policy` must be followed to exhaustion; a
# truncated sweep is indistinguishable from a prune and would corrupt the
# mirror. Proving the follow path needs a response that actually carries a
# `next_key`, which a small explicit limit produces against real data.
PAGE1="$(lcd "cosmos/group/v1/proposals_by_group_policy/$FAST_POLICY?pagination.limit=2")"
NEXT_KEY="$(echo "$PAGE1" | jq -r '.pagination.next_key // empty')"
[ -n "$NEXT_KEY" ] && ok "a limit=2 read returns a next_key (the pagination-follow path has real data)" \
  || fail "no next_key at limit=2 — the corpus cannot exercise pagination follow"
PAGE2_N="$(lcd "cosmos/group/v1/proposals_by_group_policy/$FAST_POLICY?pagination.limit=2&pagination.key=$(printf %s "$NEXT_KEY" | jq -sRr @uri)" | jq '.proposals|length')"
[ "$PAGE2_N" -gt 0 ] && ok "following next_key returns a second page of $PAGE2_N" || fail "next_key returned an empty page"

# ===========================================================================
echo; echo "########## 8/9  D2b — what does the EndBlocker actually EMIT? ##########"
# ===========================================================================
# The one open [VERIFY] this drill exists to answer (plan §7 D2b). The design
# works either way, but which way decides whether the indexer pays a
# block_results round-trip per height for information that may not exist.
# Observed across EVERY height the drill produced, not sampled.
DRILL_END_HEIGHT="$(head_height)"
BLOCK_EVENT_TYPES="[]"
SCANNED=0
for h in $(seq "$DRILL_START_HEIGHT" "$DRILL_END_HEIGHT"); do
  ev="$(group_events_at "$h")"
  [ "$ev" = "[]" ] || BLOCK_EVENT_TYPES="$(jq -cn --argjson a "$BLOCK_EVENT_TYPES" --argjson b "$ev" '$a+$b|unique')"
  SCANNED=$((SCANNED+1))
done
note "scanned $SCANNED heights ($DRILL_START_HEIGHT..$DRILL_END_HEIGHT) of finalize_block_events"
if [ "$BLOCK_EVENT_TYPES" = "[]" ]; then
  ok "the x/group EndBlocker emits NO events on this build"
  note "     -> the state sweep is the ONLY observer of a voting-period-end transition"
  note "     -> the indexer's block plane stays dead-but-ready (empty type set = no per-height fetch)"
else
  ok "x/group EndBlocker event types observed: $BLOCK_EVENT_TYPES"
  note "     -> the block plane carries the transition; the state sweep remains the authority"
fi

# ===========================================================================
echo; echo "########## 9/9  OBSERVATION RECORD ##########"
# ===========================================================================
NODE_IMAGE="$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || echo unknown)"
jq -n \
  --arg chain_id "$CHAIN_ID" \
  --arg node_image "$NODE_IMAGE" \
  --arg observed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg group_id "$GROUP_ID" \
  --arg policy "$POLICY" \
  --arg fast_policy "$FAST_POLICY" \
  --argjson policy_count "$POLICY_COUNT" \
  --arg start_height "$DRILL_START_HEIGHT" \
  --arg end_height "$DRILL_END_HEIGHT" \
  --argjson endblocker_event_types "$BLOCK_EVENT_TYPES" \
  --arg votes_open "$VOTES_OPEN" \
  --arg votes_after_tally "$VOTES_AFTER_TALLY" \
  --arg vote_change "$VOTE_CHANGE_ACCEPTED" \
  --arg two_proposers "$TWO_PROPOSER_RESULT" \
  --argjson batch_vote_in_one_tx "$BATCH_VOTE_OK" \
  --argjson prune_observed "$PRUNE_OBSERVED" \
  --argjson endblocker_prune_observed "$ENDBLOCKER_PRUNE_OBSERVED" \
  --argjson exec_success_prunes_immediately "$EXEC_SUCCESS_PRUNES_IMMEDIATELY" \
  --arg abort_outcome "$ABORT_OUTCOME" \
  --argjson contract_admin_is_policy "$CONTRACT_ADMIN_IS_POLICY" \
  --arg p_success "$P_OK" --arg p_failure "$P_FAIL" --arg p_reject "$P_REJ" \
  --arg p_notrun "$P_NOTRUN" \
  --arg p_abort "$P_ABORT" --arg p_withdraw "$P_WD" \
  --arg p_twin_a "$P_TWIN_A" --arg p_twin_b "$P_TWIN_B" --arg p_change "$P_CHANGE" \
  '{chain_id:$chain_id, node_image:$node_image, observed_at:$observed_at,
    group_id:$group_id, policy:$policy, fast_policy:$fast_policy, policy_count:$policy_count,
    height_span:{from:$start_height, to:$end_height},
    proposals:{success:$p_success, exec_failure:$p_failure, vpe_reject:$p_reject,
               accepted_not_run:$p_notrun,
               abort:$p_abort, withdraw:$p_withdraw, twin_a:$p_twin_a, twin_b:$p_twin_b,
               vote_change:$p_change},
    observations:{
      endblocker_event_types:$endblocker_event_types,
      votes_readable_while_open:$votes_open,
      votes_readable_after_tally:$votes_after_tally,
      vote_change:$vote_change,
      two_proposers_in_one_signature:$two_proposers,
      two_votes_in_one_tx:$batch_vote_in_one_tx,
      prune_observed:$prune_observed,
      endblocker_prune_observed:$endblocker_prune_observed,
      exec_success_prunes_immediately:$exec_success_prunes_immediately,
      missing_proposal_http_status:"500 (NOT 404), body identical for pruned and never-existing",
      abort_outcome:$abort_outcome,
      contract_admin_is_policy:$contract_admin_is_policy
    }}' > "$OUT"

echo
echo "== gov-drill complete: $PASS assertions passed, $SKIP skipped =="
echo "== observation record: $OUT =="
jq . "$OUT"
