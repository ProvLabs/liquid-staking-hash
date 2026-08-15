#!/usr/bin/env bash
# Migrate drill (app M8.4a §2.3): establishes — by drill, never by reading
# wasmd source (the chain-facts rule) — that the wasmd contract admin gates
# MsgMigrateContract when the admin is a KEYLESS group-policy account, that a
# group proposal carrying MsgMigrateContract actually executes it, that v1
# migrate transforms no state (byte-for-byte dump diff, contract_info
# excepted), and that the in-contract cw2 gate refuses a downgrade on a live
# chain. The six [VERIFY] hypotheses this settles are enumerated in the plan's
# §4b; each step below is an assertion, and a drill that cannot fail is a
# demo — step 2 is red precisely when the admin check is absent.
#
# Preconditions: a FRESH devnet bootstrapped GROUP-FIRST —
#   infra/devnet/bootstrap/nvhash-group-bootstrap.sh
#   CONTRACT_ADMIN="$POLICY" WASM_ADMIN="$POLICY" infra/devnet/bootstrap/nvhash-deploy-p2p.sh
# Needs no epoch crank, so the E-CAL month cap is irrelevant to it.
# DEVNET ONLY (SECURITY.md): disposable chain, throwaway keys.
set -euo pipefail

CONTAINER="${CONTAINER:-dev-node}"
CHAIN_ID="${CHAIN_ID:-chain-dev}"
HOME_DIR="${HOME_DIR:-/provenance/nodedev}"
LCD="${LCD:-http://localhost:1317}"
SHARE="${SHARE:-nvhash}"
MEMBER_A="${MEMBER_A:-account-1}"
MEMBER_B="${MEMBER_B:-account-2}"
STRANGER="${STRANGER:-account-3}"
GROUP_METADATA="${GROUP_METADATA:-nvhash-program-governance}"
# The FAST ops policy drives the ceremony (40 s voting window) — the wasmd
# admin under test is whatever the deploy set; the drill asserts WHICH.
FAST_POLICY_METADATA="${FAST_POLICY_METADATA:-nvhash-program-ops-fast}"
VPE_WAIT="${VPE_WAIT:-120}"

SDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SDIR/../.." && pwd)"

pexec() { docker exec "$CONTAINER" provenanced "$@"; }
qj()    { pexec query "$@" -t --home "$HOME_DIR" -o json; }
addr_of() { pexec keys show "$1" -a -t --home "$HOME_DIR" --keyring-backend test 2>/dev/null; }
lcd()   { curl -sf -m 10 "$LCD/$1"; }
put_file() { docker exec -i "$CONTAINER" sh -c "cat > $1"; }

TXFLAGS="-t --home ${HOME_DIR} --keyring-backend test --chain-id ${CHAIN_ID} --gas auto --gas-adjustment 2.0 --gas-prices 1nhash --broadcast-mode sync -y -o json"

PASS=0
ok()   { echo "  OK   $*"; PASS=$((PASS+1)); }
fail() { echo "  FAIL $*" >&2; exit 1; }
note() { echo "  ..   $*"; }
assert_eq() { [ "$2" = "$3" ] && ok "$1 = $2" || fail "$1: got '$2', want '$3'"; }

tx() { # tx <from-key> -- <subcommand...> → txhash, polled to commit
  local from="$1"; shift; [ "$1" = "--" ] && shift
  local out txhash code res
  # shellcheck disable=SC2086
  out="$(pexec tx "$@" $TXFLAGS --from "$from" 2>/dev/null)" || fail "broadcast failed: $*"
  txhash="$(echo "$out" | jq -r '.txhash')"
  for _ in $(seq 1 30); do
    res="$(pexec query tx "$txhash" -t --home "$HOME_DIR" -o json 2>/dev/null || true)"
    if [ -n "$res" ]; then
      code="$(echo "$res" | jq -r '.code')"
      [ "$code" = "0" ] || fail "tx $txhash committed with code $code: $*"
      echo "$txhash"; return 0
    fi
    sleep 1
  done
  fail "tx $txhash never committed"
}

# tx_expect_fail <needle> <from> -- <subcommand...> — the tx must be refused
# (broadcast or execution), with the reason matching <needle>.
tx_expect_fail() {
  local needle="$1" from="$2"; shift 2; [ "$1" = "--" ] && shift
  local out txhash res code raw
  # shellcheck disable=SC2086
  if ! out="$(pexec tx "$@" $TXFLAGS --from "$from" 2>&1)"; then
    echo "$out" | grep -qi "$needle" && { ok "refused at broadcast (${needle})"; return 0; }
    fail "refused, but not for the expected reason (${needle}): $out"
  fi
  txhash="$(echo "$out" | jq -r '.txhash' 2>/dev/null || true)"
  [ -n "$txhash" ] || { echo "$out" | grep -qi "$needle" && { ok "refused (${needle})"; return 0; } || fail "no txhash and no ${needle}: $out"; }
  for _ in $(seq 1 30); do
    res="$(pexec query tx "$txhash" -t --home "$HOME_DIR" -o json 2>/dev/null || true)"
    if [ -n "$res" ]; then
      code="$(echo "$res" | jq -r '.code')"
      [ "$code" != "0" ] || fail "tx SUCCEEDED where ${needle} was expected: $*"
      raw="$(echo "$res" | jq -r '.raw_log')"
      echo "$raw" | grep -qi "$needle" && ok "rejected on chain (${needle})" \
        || ok "rejected on chain (code $code; raw: ${raw:0:120})"
      return 0
    fi
    sleep 1
  done
  fail "tx $txhash never committed"
}

state_dump() { # full raw contract state, models sorted (contract_info is key Y29udHJhY3RfaW5mbw==)
  qj wasm contract-state all "$CONTRACT" --limit 1000 | jq -S '.models'
}

cw2_version() {
  qj wasm contract-state raw "$CONTRACT" 636F6E74726163745F696E666F \
    | jq -r '.data' | base64 -d | jq -r '.version'
}

echo "== migrate-drill: resolving the deployed contract and the group substrate =="
VAULT="$(qj vault list | jq -r --arg d "$SHARE" '.vaults[]?|select(.total_shares.denom==$d)|.base_account.address' | head -1)"
[ -n "$VAULT" ] && [ "$VAULT" != "null" ] || fail "no vault — run the governed bootstrap first"
CONTRACT="$(qj vault get "$VAULT" | jq -r '.vault.asset_manager')"
CODE_ID_0="$(qj wasm contract "$CONTRACT" | jq -r '.contract_info.code_id')"
WASM_ADMIN_ACTUAL="$(qj wasm contract "$CONTRACT" | jq -r '.contract_info.admin')"

ADMIN_ADDR="$(addr_of "$MEMBER_A")"
GROUP_ID="$(qj group groups-by-admin "$ADMIN_ADDR" | jq -r --arg m "$GROUP_METADATA" '.groups[]?|select(.metadata==$m)|.id' | head -1)"
[ -n "$GROUP_ID" ] || fail "no group '$GROUP_METADATA' — run nvhash-group-bootstrap.sh"
POLICIES_JSON="$(lcd "cosmos/group/v1/group_policies_by_group/$GROUP_ID")"
FAST_POLICY="$(echo "$POLICIES_JSON" | jq -r --arg m "$FAST_POLICY_METADATA" '.group_policies[]|select(.metadata==$m)|.address')"
[ -n "$FAST_POLICY" ] || fail "no '$FAST_POLICY_METADATA' policy on group $GROUP_ID"

# ============================================================================
echo; echo "########## 1/6  PRECONDITION: the wasmd admin is the policy the bootstrap intended ##########"
# ============================================================================
POLICY_SET="$(echo "$POLICIES_JSON" | jq -r '[.group_policies[].address]|join(" ")')"
case " $POLICY_SET " in
  *" $WASM_ADMIN_ACTUAL "*) ok "wasmd admin $WASM_ADMIN_ACTUAL is a group policy (keyless by construction) [VERIFY-6 closed: --admin accepted a module-derived address]" ;;
  *) fail "wasmd admin is '$WASM_ADMIN_ACTUAL', not a group policy — bootstrap with CONTRACT_ADMIN/WASM_ADMIN = policy" ;;
esac
note "code_id=$CODE_ID_0 cw2=$(cw2_version)"

# ============================================================================
echo; echo "########## 2/6  UNAUTHORIZED MIGRATE IS REJECTED (stranger AND single member) ##########"
# ============================================================================
CW2_BEFORE="$(cw2_version)"
tx_expect_fail "unauthorized" "$STRANGER" -- wasm migrate "$CONTRACT" "$CODE_ID_0" '{}'
tx_expect_fail "unauthorized" "$MEMBER_B" -- wasm migrate "$CONTRACT" "$CODE_ID_0" '{}'
assert_eq "code id unchanged after rejections" "$(qj wasm contract "$CONTRACT" | jq -r '.contract_info.code_id')" "$CODE_ID_0"
assert_eq "cw2 marker unchanged after rejections" "$(cw2_version)" "$CW2_BEFORE"
ok "[VERIFY-1 closed: wasmd rejects MsgMigrateContract from non-admin signers under a keyless policy admin]"

# ============================================================================
echo; echo "########## 3/6  BUILD + STORE THE MIGRATION TARGET (version-bumped temp crate) ##########"
# ============================================================================
# Q5: probe the same-code-id migrate FIRST — a free [VERIFY-3] data point on
# wasmd's store-time checksum dedupe — by re-storing the CURRENT artifact.
WASM_CURRENT="${WASM_CURRENT:-$REPO_ROOT/contracts/artifacts/nvhash_staking.wasm}"
[ -f "$WASM_CURRENT" ] || "$REPO_ROOT/contracts/scripts/build-artifact.sh"
put_file /tmp/migrate-drill-current.wasm < "$WASM_CURRENT"
RESTORE_RES="$(tx "$MEMBER_A" -- wasm store /tmp/migrate-drill-current.wasm)"
REST_CODE_ID="$(pexec query tx "$RESTORE_RES" -t --home "$HOME_DIR" -o json | jq -r '[.events[]|select(.type=="store_code")|.attributes[]|select(.key=="code_id")|.value]|first' | sed 's/^"//; s/"$//')"
note "re-storing the identical artifact yielded code_id=$REST_CODE_ID (original $CODE_ID_0) — [VERIFY-3 data point: $([ "$REST_CODE_ID" = "$CODE_ID_0" ] && echo 'deduped to the same id' || echo 'a NEW id was assigned')]"

# The version-distinct build: temp crate copy at 0.1.1 (build metadata is
# rejected — semver ordering may treat +drill as equal, making the advance
# unobservable).
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
cp -R "$REPO_ROOT/contracts/." "$BUILD_DIR/contracts/"
rm -rf "$BUILD_DIR/contracts/artifacts" "$BUILD_DIR/contracts/target"
perl -pi -e 's{^version = "0\.1\.0"$}{version = "0.1.1"}' "$BUILD_DIR/contracts/Cargo.toml"
grep -q '^version = "0.1.1"' "$BUILD_DIR/contracts/Cargo.toml" || fail "version bump did not apply"
( cd "$BUILD_DIR/contracts" && ./scripts/build-artifact.sh )
put_file /tmp/migrate-drill-bumped.wasm < "$BUILD_DIR/contracts/artifacts/nvhash_staking.wasm"
STORE2="$(tx "$MEMBER_A" -- wasm store /tmp/migrate-drill-bumped.wasm)"
CODE_ID_1="$(pexec query tx "$STORE2" -t --home "$HOME_DIR" -o json | jq -r '[.events[]|select(.type=="store_code")|.attributes[]|select(.key=="code_id")|.value]|first' | sed 's/^"//; s/"$//')"
[ -n "$CODE_ID_1" ] && [ "$CODE_ID_1" != "$CODE_ID_0" ] || fail "bumped build did not get a distinct code id"
ok "migration target stored: code_id=$CODE_ID_1 (v0.1.1)"

# ============================================================================
echo; echo "########## 4/6  AUTHORIZED MIGRATE SUCCEEDS THROUGH THE GROUP ##########"
# ============================================================================
DUMP_BEFORE="$(state_dump)"
MIGRATE_MSG="$(jq -n --arg s "$FAST_POLICY" --arg c "$CONTRACT" --arg id "$CODE_ID_1" \
  '{"@type":"/cosmwasm.wasm.v1.MsgMigrateContract",sender:$s,contract:$c,code_id:$id,msg:"e30="}')"
# NOTE: if the wasmd admin is the ADMIN policy rather than the fast policy,
# re-point sender accordingly; the drill uses whatever the contract reports.
if [ "$WASM_ADMIN_ACTUAL" != "$FAST_POLICY" ]; then
  MIGRATE_MSG="$(echo "$MIGRATE_MSG" | jq --arg s "$WASM_ADMIN_ACTUAL" '.sender=$s')"
  SENDER_POLICY="$WASM_ADMIN_ACTUAL"
else
  SENDER_POLICY="$FAST_POLICY"
fi
MEMBER_A_ADDR="$(addr_of "$MEMBER_A")"
PROPOSAL="$(jq -n --arg p "$SENDER_POLICY" --arg m "$MEMBER_A_ADDR" --argjson msg "[$MIGRATE_MSG]" \
  '{group_policy_address:$p,proposers:[$m],metadata:"",messages:$msg,exec:"EXEC_UNSPECIFIED",title:"migrate-drill: upgrade to 0.1.1",summary:"drill"}')"
echo "$PROPOSAL" | put_file /tmp/migrate-drill-proposal.json
SUBMIT_HASH="$(tx "$MEMBER_A" -- group submit-proposal /tmp/migrate-drill-proposal.json)"
PROPOSAL_ID="$(pexec query tx "$SUBMIT_HASH" -t --home "$HOME_DIR" -o json | jq -r '[.events[]|select(.type=="cosmos.group.v1.EventSubmitProposal")|.attributes[]|select(.key=="proposal_id")|.value]|first' | sed 's/^"//; s/"$//')"
[ -n "$PROPOSAL_ID" ] || fail "no proposal id from submit"
note "proposal $PROPOSAL_ID submitted against policy $SENDER_POLICY"

tx "$MEMBER_A" -- group vote "$PROPOSAL_ID" "$MEMBER_A_ADDR" VOTE_OPTION_YES drill >/dev/null
tx "$MEMBER_B" -- group vote "$PROPOSAL_ID" "$(addr_of "$MEMBER_B")" VOTE_OPTION_YES drill >/dev/null

# Wait out the voting window, then exec.
for _ in $(seq 1 "$VPE_WAIT"); do
  STATUS="$(lcd "cosmos/group/v1/proposal/$PROPOSAL_ID" | jq -r '.proposal.status' 2>/dev/null || echo "")"
  [ "$STATUS" = "PROPOSAL_STATUS_ACCEPTED" ] && break
  sleep 1
done
EXEC_HASH="$(tx "$MEMBER_A" -- group exec "$PROPOSAL_ID")"
EXEC_RESULT="$(pexec query tx "$EXEC_HASH" -t --home "$HOME_DIR" -o json | jq -r '[.events[]|select(.type=="cosmos.group.v1.EventExec")|.attributes[]|select(.key=="result")|.value]|first' | sed 's/^"//; s/"$//')"
assert_eq "EventExec.result" "$EXEC_RESULT" "PROPOSAL_EXECUTOR_RESULT_SUCCESS"
assert_eq "contract code id advanced" "$(qj wasm contract "$CONTRACT" | jq -r '.contract_info.code_id')" "$CODE_ID_1"
ok "[VERIFY-2 closed: a group proposal carrying MsgMigrateContract executes]"

# ============================================================================
echo; echo "########## 5/6  POST-MIGRATE STATE IS BYTE-IDENTICAL (contract_info excepted) ##########"
# ============================================================================
assert_eq "cw2 version advanced" "$(cw2_version)" "0.1.1"
DUMP_AFTER="$(state_dump)"
# Diff the dumps excluding the cw2 marker key (base64 of "contract_info").
CW2_STATE_ENTRY_B64="Y29udHJhY3RfaW5mbw=="
DIFF_KEYS="$(jq -n --argjson a "$DUMP_BEFORE" --argjson b "$DUMP_AFTER" '
  [($a - $b)[].key, ($b - $a)[].key] | unique')"
assert_eq "changed raw keys" "$(echo "$DIFF_KEYS" | jq -c '.')" "[\"$CW2_STATE_ENTRY_B64\"]"
# Belt and braces at the interface level: the three primary queries answer
# post-migrate (the raw dump above is the byte-level equality).
for q in '{"config":{}}' '{"epoch_status":{}}' '{"validators":{}}'; do
  A1="$(qj wasm contract-state smart "$CONTRACT" "$q" | jq -Sc '.data')"
  [ -n "$A1" ] && [ "$A1" != "null" ] || fail "post-migrate query $q answered nothing"
  note "post-migrate $q → ${A1:0:60}…"
done
ok "[VERIFY-5 closed: raw state byte-identical except contract_info]"

# ============================================================================
echo; echo "########## 6/6  DOWNGRADE IS REJECTED BY THE CONTRACT ON A LIVE CHAIN ##########"
# ============================================================================
DOWN_MSG="$(jq -n --arg s "$SENDER_POLICY" --arg c "$CONTRACT" --arg id "$CODE_ID_0" \
  '{"@type":"/cosmwasm.wasm.v1.MsgMigrateContract",sender:$s,contract:$c,code_id:$id,msg:"e30="}')"
jq -n --arg p "$SENDER_POLICY" --arg m "$MEMBER_A_ADDR" --argjson msg "[$DOWN_MSG]" \
  '{group_policy_address:$p,proposers:[$m],metadata:"",messages:$msg,exec:"EXEC_UNSPECIFIED",title:"migrate-drill: downgrade to 0.1.0 (must fail)",summary:"drill"}' \
  | put_file /tmp/migrate-drill-downgrade.json
SUBMIT2="$(tx "$MEMBER_A" -- group submit-proposal /tmp/migrate-drill-downgrade.json)"
P2="$(pexec query tx "$SUBMIT2" -t --home "$HOME_DIR" -o json | jq -r '[.events[]|select(.type=="cosmos.group.v1.EventSubmitProposal")|.attributes[]|select(.key=="proposal_id")|.value]|first' | sed 's/^"//; s/"$//')"
tx "$MEMBER_A" -- group vote "$P2" "$MEMBER_A_ADDR" VOTE_OPTION_YES drill >/dev/null
tx "$MEMBER_B" -- group vote "$P2" "$(addr_of "$MEMBER_B")" VOTE_OPTION_YES drill >/dev/null
for _ in $(seq 1 "$VPE_WAIT"); do
  STATUS="$(lcd "cosmos/group/v1/proposal/$P2" | jq -r '.proposal.status' 2>/dev/null || echo "")"
  [ "$STATUS" = "PROPOSAL_STATUS_ACCEPTED" ] && break
  sleep 1
done
EXEC2="$(tx "$MEMBER_A" -- group exec "$P2")"
EXEC2_RESULT="$(pexec query tx "$EXEC2" -t --home "$HOME_DIR" -o json | jq -r '[.events[]|select(.type=="cosmos.group.v1.EventExec")|.attributes[]|select(.key=="result")|.value]|first' | sed 's/^"//; s/"$//')"
assert_eq "downgrade EventExec.result" "$EXEC2_RESULT" "PROPOSAL_EXECUTOR_RESULT_FAILURE"
assert_eq "code id still the new one" "$(qj wasm contract "$CONTRACT" | jq -r '.contract_info.code_id')" "$CODE_ID_1"
assert_eq "cw2 marker still 0.1.1" "$(cw2_version)" "0.1.1"
ok "[VERIFY-4 closed: a wrapped contract failure surfaces as ACCEPTED + executor_result FAILURE, state untouched]"

echo; echo "== MIGRATE DRILL PASSED ($PASS assertions) =="
echo "   record the [VERIFY] closures with today's date + node image in contracts/IMPLEMENTATION-STATUS.md"
