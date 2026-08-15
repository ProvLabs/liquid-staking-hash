#!/usr/bin/env bash
# Steps 1–2 — the program group and BOTH policies, BEFORE anything else
# (plan 8.4 §2.6.2; D25: split-at-bootstrap on every non-devnet deployment).
#
# ORDER IS LOAD-BEARING AND MECHANICAL: the contract has no admin-rotation
# message (`ExecuteMsg` has no variant that changes Config.admin), so a
# contract instantiated before its policy exists can never be handed to it.
# testnet-deploy.sh hard-stops unless the assertions here have passed.
#
# Voting windows are production-shaped ops parameters (§7 Q3 — hours, never
# devnet's 300s/40s drill affordances); membership for the pilot is the
# program engineering key set (addresses only — keys stay in the store);
# thresholds remain 8.5 launch-ops parameters.
set -euo pipefail
SDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/deploy/bootstrap/_lib.sh
source "$SDIR/_lib.sh"

require_probe_passed
require_value TESTNET_NODE
require_value TESTNET_LCD
# Comma-separated bech32 member addresses (public facts; equal weight 1 for
# the pilot — thresholds are 8.5's).
require_value GROUP_MEMBERS
# Voting window for both policies, e.g. "12h" (§7 Q3).
require_value VOTING_PERIOD
GROUP_METADATA="${GROUP_METADATA:-nvhash program group (testnet pilot)}"
ADMIN_POLICY_METADATA="${ADMIN_POLICY_METADATA:-nvhash admin policy}"
OPS_POLICY_METADATA="${OPS_POLICY_METADATA:-nvhash ops policy}"

assert_chain_id
setup_pilot_key

members_json="$(mktemp)"
trap 'rm -f "$members_json"; rm -rf "$KEYRING_DIR"' EXIT
{
  echo '{"members": ['
  first=1
  IFS=, read -ra addrs <<<"$GROUP_MEMBERS"
  for addr in "${addrs[@]}"; do
    [[ "$addr" =~ ^[a-z]+1[a-z0-9]{8,90}$ ]] || refuse "member not bech32-shaped: $addr"
    [[ $first -eq 1 ]] || echo ','
    first=0
    printf '{"address": "%s", "weight": "1", "metadata": ""}' "$addr"
  done
  echo ']}'
} > "$members_json"

# Lookup-before-create: a group with our metadata under the pilot admin means
# a prior run got this far — converge on it (C6).
existing_group="$(lcd_get "/cosmos/group/v1/groups_by_admin/${PILOT_ADDR}" 2>/dev/null \
  | jq -r --arg m "$GROUP_METADATA" '.groups[]? | select(.metadata == $m) | .id' | head -1 || true)"
if [[ -n "$existing_group" ]]; then
  group_id="$existing_group"
  echo "group exists: id=${group_id} (converging on prior run)" >&2
else
  tx group create-group "$PILOT_ADDR" "$GROUP_METADATA" "$members_json" >/dev/null
  group_id="$(lcd_get "/cosmos/group/v1/groups_by_admin/${PILOT_ADDR}" \
    | jq -r --arg m "$GROUP_METADATA" '.groups[] | select(.metadata == $m) | .id' | head -1)"
  [[ -n "$group_id" ]] || refuse "group creation produced no readable group (assertion, not tx code)"
fi

create_policy() {
  local metadata="$1"
  local existing
  existing="$(lcd_get "/cosmos/group/v1/group_policies_by_group/${group_id}" \
    | jq -r --arg m "$metadata" '.group_policies[]? | select(.metadata == $m) | .address' | head -1 || true)"
  if [[ -n "$existing" ]]; then
    echo "$existing"
    return 0
  fi
  local policy_json
  policy_json="$(mktemp)"
  printf '{"@type": "/cosmos.group.v1.ThresholdDecisionPolicy", "threshold": "2", "windows": {"voting_period": "%s", "min_execution_period": "0s"}}' \
    "$VOTING_PERIOD" > "$policy_json"
  tx group create-group-policy "$PILOT_ADDR" "$group_id" "$metadata" "$policy_json" >/dev/null
  rm -f "$policy_json"
  lcd_get "/cosmos/group/v1/group_policies_by_group/${group_id}" \
    | jq -r --arg m "$metadata" '.group_policies[] | select(.metadata == $m) | .address' | head -1
}

admin_policy="$(create_policy "$ADMIN_POLICY_METADATA")"
ops_policy="$(create_policy "$OPS_POLICY_METADATA")"

# ── Assertions (reads, never tx codes — §4 invariant 4) ────────────────────
group_meta="$(lcd_get "/cosmos/group/v1/group_info/${group_id}" | jq -r '.info.metadata')"
assert_eq "group metadata" "$group_meta" "$GROUP_METADATA"

policy_count="$(lcd_get "/cosmos/group/v1/group_policies_by_group/${group_id}" \
  | jq -r --arg a "$ADMIN_POLICY_METADATA" --arg o "$OPS_POLICY_METADATA" \
      '[.group_policies[] | select(.metadata == $a or .metadata == $o)] | length')"
assert_eq "expected policies resolve by metadata" "$policy_count" "2"

for policy in "$admin_policy" "$ops_policy"; do
  [[ "$policy" =~ ^[a-z]+1[a-z0-9]{8,90}$ ]] || refuse "policy address not bech32: $policy"
  # Fund each policy account so proposal execution can pay fees (the devnet
  # precedent); skip when already funded.
  balance="$(lcd_get "/cosmos/bank/v1beta1/balances/${policy}/by_denom?denom=nhash" \
    | jq -r '.balance.amount // "0"')"
  if [[ "$balance" == "0" ]]; then
    tx bank send "$PILOT_ADDR" "$policy" "${POLICY_FUNDING:-100000000000nhash}" >/dev/null
  fi
  funded="$(lcd_get "/cosmos/bank/v1beta1/balances/${policy}/by_denom?denom=nhash" \
    | jq -r '.balance.amount // "0"')"
  [[ "$funded" != "0" ]] || refuse "policy $policy is unfunded after funding step"
  echo "  ok: policy $policy funded (${funded}nhash)" >&2
done

{
  echo "group_id=${group_id}"
  echo "admin_policy=${admin_policy}"
  echo "ops_policy=${ops_policy}"
} | tee "$STATE_DIR/group.env"

echo >&2
echo "ADMIN POLICY ADDRESS (testnet-deploy.sh consumes this): ${admin_policy}" >&2
