#!/usr/bin/env bash
# nvHASH devnet x/group substrate: create the governance group + threshold
# policy the App's governance surfaces mirror, and print the POLICY ADDRESS so
# `nvhash-deploy-p2p.sh` can consume it through its existing `CONTRACT_ADMIN`
# hook.
#
# WHY THIS RUNS BEFORE DEPLOY (app plan M7 overview finding F2). The staking
# contract has NO admin-rotation path: `ExecuteMsg` carries no variant that
# changes `Config.admin`, and `InstantiateMsg.admin` is set once at instantiate.
# So the policy account must exist BEFORE the contract is instantiated, and the
# only supported order is:
#
#     POLICY="$(infra/devnet/bootstrap/nvhash-group-bootstrap.sh --quiet)"
#     CONTRACT_ADMIN="$POLICY" infra/devnet/bootstrap/nvhash-deploy-p2p.sh
#
# Running this against a chain whose contract is already deployed is supported
# and useful (it is how the x/group lifecycle drill and the fixture corpus are
# produced), but the contract's admin stays whatever it was — see the warning
# this script prints, and infra/devnet/README.md.
#
# SECURITY.md devnet posture: this script uses EXISTING throwaway keyring
# entries, generates no key material, accepts no mnemonic, writes nothing to
# `state/`, and points only at the disposable local chain.
#
# Idempotent: a group already carrying `GROUP_METADATA` is reused, and its
# first threshold policy is reported rather than a second one created.
set -euo pipefail

CONTAINER="${CONTAINER:-dev-node}"
CHAIN_ID="${CHAIN_ID:-chain-dev}"
HOME_DIR="${HOME_DIR:-/provenance/nodedev}"

# The group admin. A PLAIN account deliberately: the drill's ABORTED case needs
# a signer that can `update-group-members` mid-vote, which a self-administered
# policy could only do through another proposal. Mainnet topology is a
# spec-level decision (liquid-staking-spec §12.1), not this script's default.
GOV_ADMIN="${GOV_ADMIN:-account-1}"
# Three existing keyring entries, weights 1/1/1. Threshold 2 means no single
# member can pass a proposal and no single member can block one.
GOV_MEMBERS="${GOV_MEMBERS:-account-1,account-2,validator}"
GOV_WEIGHTS="${GOV_WEIGHTS:-1,1,1}"
GOV_THRESHOLD="${GOV_THRESHOLD:-2}"
# DEVNET-ONLY voting periods. Both are short enough for a drill to observe a
# whole lifecycle in one run and neither is a mainnet fact — the fixture
# manifest labels them devnet-only so nobody reads them as program policy.
#
# TWO policies on ONE group, deliberately. The App discovers the policy set
# (M7.1 §2.1, decision D1) and must never assume there is exactly one, because
# the dual `admin`/`ops` split in contracts/IMPLEMENTATION-STATUS.md is still
# open. Bootstrapping two means the fixture corpus CONTAINS the 1..n case
# instead of the code merely claiming to handle it. They also differ in the one
# parameter a drill needs to differ:
#   - primary ("admin"): long enough to cast two votes and execute (~5 min);
#   - fast ("ops"): short enough to watch a proposal expire, abort, and get
#     pruned without waiting out the primary window.
GOV_VOTING_PERIOD="${GOV_VOTING_PERIOD:-300s}"
GOV_FAST_VOTING_PERIOD="${GOV_FAST_VOTING_PERIOD:-40s}"
GOV_MIN_EXECUTION_PERIOD="${GOV_MIN_EXECUTION_PERIOD:-0s}"
# x/group prunes a proposal once `voting_period_end + max_execution_period` has
# passed (chain param, not a policy field) — the drill observes the actual
# window rather than assuming it.
GROUP_METADATA="${GROUP_METADATA:-nvhash-program-governance}"
POLICY_METADATA="${POLICY_METADATA:-nvhash-program-admin}"
FAST_POLICY_METADATA="${FAST_POLICY_METADATA:-nvhash-program-ops-fast}"
# Seed balance for the policy account, so a proposal whose messages spend from
# the policy (the drill's benign SUCCESS case) can actually execute.
POLICY_FUNDING="${POLICY_FUNDING:-100000000000nhash}"

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

GAS_ARGS="--gas auto --gas-adjustment 2.0 --gas-prices 1nhash"
COMMON="-t --home ${HOME_DIR} --keyring-backend test --chain-id ${CHAIN_ID} ${GAS_ARGS} --broadcast-mode sync -y -o json"

pexec() { docker exec "$CONTAINER" provenanced "$@"; }
qj()    { pexec query "$@" -t --home "$HOME_DIR" -o json; }
addr_of() { pexec keys show "$1" -a -t --home "$HOME_DIR" --keyring-backend test 2>/dev/null; }
say() { [ "$QUIET" = "1" ] || echo "$@" >&2; }

tx() {
  say "+ tx $*"
  local out txhash code res
  out="$(pexec tx "$@" $COMMON 2>/dev/null)"
  code="$(echo "$out" | jq -r '.code // empty')"; txhash="$(echo "$out" | jq -r '.txhash // empty')"
  [ -n "$txhash" ] || { echo "TX BROADCAST FAILED: $out" >&2; exit 1; }
  [ "$code" = "0" ] || { echo "TX REJECTED (code=$code): $(echo "$out" | jq -r '.raw_log')" >&2; exit 1; }
  for _ in $(seq 1 30); do
    res="$(pexec query tx "$txhash" -t --home "$HOME_DIR" -o json 2>/dev/null || true)"
    code="$(echo "$res" | jq -r '.code // empty' 2>/dev/null || true)"
    [ -n "$code" ] && break; sleep 1
  done
  [ "$code" = "0" ] || { echo "TX FAILED (code=${code:-?}): $(echo "$res" | jq -r '.raw_log // "not committed"')" >&2; exit 1; }
  say "  ok ($txhash)"
}

# Write a file INSIDE the container (the group CLI takes file paths, and the
# keyring lives in the container).
put_file() { # put_file <path> <<<content
  docker exec -i "$CONTAINER" sh -c "cat > $1"
}

# ---------------------------------------------------------------------------
# 0) FEATURE PROBE — does this node image serve x/group at all?
# ---------------------------------------------------------------------------
# The App's whole governance surface rests on it, and finding out here (loudly,
# once) beats a worker that quietly indexes nothing. Same posture as the
# app-spec §14.2 vault feature probe.
say "== probe: x/group on this build =="
ADMIN_ADDR="$(addr_of "$GOV_ADMIN")"
[ -n "$ADMIN_ADDR" ] || { echo "admin key '$GOV_ADMIN' not in the container keyring" >&2; exit 1; }
if ! qj group groups-by-admin "$ADMIN_ADDR" >/dev/null 2>&1; then
  cat >&2 <<'EOF'
FATAL: this node build does not serve x/group.

  `provenanced q group groups-by-admin <addr>` failed. The App's governance
  milestone (M7) has no substrate on such a build: there is nothing to index,
  no fixture to capture, and no live path to certify. This is a hard stop, not
  a degraded mode — see docs/plans/2026-07-28-app-m7.1-governance-indexing.md
  §8 "stop-and-ask triggers".
EOF
  exit 1
fi
say "  x/group is served"

# ---------------------------------------------------------------------------
# 1) The group (idempotent by metadata)
# ---------------------------------------------------------------------------
existing_group() {
  qj group groups-by-admin "$ADMIN_ADDR" 2>/dev/null \
    | jq -r --arg m "$GROUP_METADATA" '.groups[]? | select(.metadata==$m) | .id' | head -1
}

GROUP_ID="$(existing_group)"
if [ -n "$GROUP_ID" ]; then
  say "== group '$GROUP_METADATA' already exists (id=$GROUP_ID) =="
else
  say "== create group '$GROUP_METADATA' (admin=$GOV_ADMIN) =="
  IFS=',' read -r -a MEMBER_KEYS <<< "$GOV_MEMBERS"
  IFS=',' read -r -a MEMBER_WEIGHTS <<< "$GOV_WEIGHTS"
  [ "${#MEMBER_KEYS[@]}" = "${#MEMBER_WEIGHTS[@]}" ] || {
    echo "GOV_MEMBERS and GOV_WEIGHTS must have the same length" >&2; exit 1; }

  members_json='{"members":['
  for i in "${!MEMBER_KEYS[@]}"; do
    a="$(addr_of "${MEMBER_KEYS[$i]}")"
    [ -n "$a" ] || { echo "member key '${MEMBER_KEYS[$i]}' not in the container keyring" >&2; exit 1; }
    [ "$i" = "0" ] || members_json+=','
    members_json+="{\"address\":\"$a\",\"weight\":\"${MEMBER_WEIGHTS[$i]}\",\"metadata\":\"${MEMBER_KEYS[$i]}\"}"
    say "  member ${MEMBER_KEYS[$i]} = $a (weight ${MEMBER_WEIGHTS[$i]})"
  done
  members_json+=']}'
  put_file /tmp/nvhash-group-members.json <<<"$members_json"

  put_file /tmp/nvhash-group-policy.json <<JSON
{"@type":"/cosmos.group.v1.ThresholdDecisionPolicy",
 "threshold":"${GOV_THRESHOLD}",
 "windows":{"voting_period":"${GOV_VOTING_PERIOD}","min_execution_period":"${GOV_MIN_EXECUTION_PERIOD}"}}
JSON

  tx group create-group-with-policy "$ADMIN_ADDR" "$GROUP_METADATA" "$POLICY_METADATA" \
    /tmp/nvhash-group-members.json /tmp/nvhash-group-policy.json --from "$GOV_ADMIN"
  GROUP_ID="$(existing_group)"
fi
[ -n "$GROUP_ID" ] || { echo "could not resolve the group id after create" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 2) The policy set (1..n, never "the" policy)
# ---------------------------------------------------------------------------
policy_by_metadata() {
  qj group group-policies-by-group "$GROUP_ID" 2>/dev/null \
    | jq -r --arg m "$1" '.group_policies[]? | select(.metadata==$m) | .address' | head -1
}

POLICY_ADDR="$(policy_by_metadata "$POLICY_METADATA")"
[ -n "$POLICY_ADDR" ] || { echo "group $GROUP_ID has no '$POLICY_METADATA' policy" >&2; exit 1; }

FAST_POLICY_ADDR="$(policy_by_metadata "$FAST_POLICY_METADATA")"
if [ -z "$FAST_POLICY_ADDR" ]; then
  say "== create second policy '$FAST_POLICY_METADATA' (fast voting period) =="
  put_file /tmp/nvhash-group-policy-fast.json <<JSON
{"@type":"/cosmos.group.v1.ThresholdDecisionPolicy",
 "threshold":"${GOV_THRESHOLD}",
 "windows":{"voting_period":"${GOV_FAST_VOTING_PERIOD}","min_execution_period":"${GOV_MIN_EXECUTION_PERIOD}"}}
JSON
  tx group create-group-policy "$ADMIN_ADDR" "$GROUP_ID" "$FAST_POLICY_METADATA" \
    /tmp/nvhash-group-policy-fast.json --from "$GOV_ADMIN"
  FAST_POLICY_ADDR="$(policy_by_metadata "$FAST_POLICY_METADATA")"
fi
[ -n "$FAST_POLICY_ADDR" ] || { echo "could not resolve the fast policy after create" >&2; exit 1; }

say "== group substrate =="
say "  group id         : $GROUP_ID"
say "  group admin      : $ADMIN_ADDR ($GOV_ADMIN)"
say "  policy (admin)   : $POLICY_ADDR   vp=$GOV_VOTING_PERIOD"
say "  policy (ops-fast): $FAST_POLICY_ADDR   vp=$GOV_FAST_VOTING_PERIOD"
say "  threshold        : $GOV_THRESHOLD of $(qj group group-info "$GROUP_ID" | jq -r '.info.total_weight')"
say "  voting periods are DEVNET-ONLY — never mainnet facts"

# ---------------------------------------------------------------------------
# 3) Fund the policy accounts
# ---------------------------------------------------------------------------
# A group policy is a module-derived account with no balance of its own. The
# drill's benign SUCCESS proposal spends from it, so seed it. Not a key: the
# policy account has no private key by construction, which is the point.
fund_policy() {
  local addr="$1" bal
  bal="$(qj bank balances "$addr" 2>/dev/null | jq -r '.balances[]?|select(.denom=="nhash")|.amount' | head -1)"
  if [ -z "${bal:-}" ] || [ "$bal" = "0" ]; then
    say "== fund $addr with $POLICY_FUNDING =="
    tx bank send "$ADMIN_ADDR" "$addr" "$POLICY_FUNDING" --from "$GOV_ADMIN"
  else
    say "  balance $addr: ${bal}nhash (already funded)"
  fi
}
fund_policy "$POLICY_ADDR"
fund_policy "$FAST_POLICY_ADDR"

# ---------------------------------------------------------------------------
# 4) Is the contract's admin this policy?
# ---------------------------------------------------------------------------
# Reported, never fixed here: there is no admin-rotation message (F2), so the
# only way to make it true is a fresh bootstrap with CONTRACT_ADMIN set.
CONTRACT="$(qj vault list 2>/dev/null | jq -r '.vaults[]?|select(.total_shares.denom=="nvhash")|.base_account.address' | head -1)"
if [ -n "${CONTRACT:-}" ] && [ "$CONTRACT" != "null" ]; then
  CONTRACT="$(qj vault get "$CONTRACT" 2>/dev/null | jq -r '.vault.asset_manager // empty')"
fi
if [ -n "${CONTRACT:-}" ]; then
  CUR_ADMIN="$(qj wasm contract-state smart "$CONTRACT" '{"config":{}}' 2>/dev/null | jq -r '.data.admin // empty')"
  if [ "$CUR_ADMIN" = "$POLICY_ADDR" ]; then
    say "  contract admin : $CUR_ADMIN == this policy (governance topology is REAL)"
  else
    say ""
    say "  !! contract admin is $CUR_ADMIN, NOT this policy."
    say "  !! The contract has no admin-rotation message (M7 overview F2), so"
    say "  !! making the policy the admin requires a FULL DEVNET RESET:"
    say "  !!"
    say "  !!   infra/devnet/dev-node.sh reset   # or your usual chain reset"
    say "  !!   POLICY=\"\$(infra/devnet/bootstrap/nvhash-group-bootstrap.sh --quiet)\""
    say "  !!   CONTRACT_ADMIN=\"\$POLICY\" infra/devnet/bootstrap/nvhash-deploy-p2p.sh"
    say "  !!"
    say "  !! Until then the App's policy DISCOVERY path (Config.admin -> policy"
    say "  !! -> group -> policies) resolves to the empty set, which is the honest"
    say "  !! no-governance state. Point the indexer at this policy explicitly"
    say "  !! with GOV_GROUP_POLICIES=$POLICY_ADDR to index it anyway."
    say ""
  fi
fi

# The one thing on stdout: the PRIMARY policy address, for
# `CONTRACT_ADMIN=$(...)`. The rest of the set is discovered from it — that is
# the whole point of §2.1's set-valued discovery, and printing two addresses
# here would invite a caller to hardcode both.
echo "$POLICY_ADDR"
