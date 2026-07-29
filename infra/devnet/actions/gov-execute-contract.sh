#!/usr/bin/env bash
# Usage: gov-execute-contract.sh <execute-msg-json> [voter-key,...]
#
# Run one admin-gated contract call THROUGH governance: wrap it as a
# `MsgExecuteContract` from the policy account, submit it as an x/group
# proposal, vote it past the threshold, and execute it. Prints the proposal id.
#
# WHY THIS EXISTS. Once `Config.admin` is a group policy — the topology
# liquid-staking-spec §12.1 describes and App PR 7.1 made real on devnet — a
# direct `wasm execute {"update_config":…}` from a member account is rejected as
# Unauthorized. Every admin-gated devnet operation has to become a proposal, and
# spreading that ceremony across the drills would duplicate it. It lives here
# once.
#
# It is also the shape the App's own admin path takes (app-spec §8.7/§14.6):
# admin program-ops reach the chain ONLY as template-scoped proposals, never as
# direct admin transactions. So the proposals this script produces are the same
# `MsgExecuteContract`-inside-a-proposal payload that PR 7.4's template guard
# must canonically re-encode — which is why the fixture corpus wants them.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
[ $# -ge 1 ] || { echo "usage: $0 <execute-msg-json> [voter-key,...]" >&2; exit 1; }

MSG="$1"
VOTERS="${2:-account-1,account-2}"

resolve
resolve_gov_policy

# `msg` goes in as an INLINE JSON OBJECT, not a base64 string. `MsgExecuteContract.msg`
# is proto `bytes`, so base64 is what proto-JSON would normally require — but
# cosmwasm types it as `RawContractMessage`, whose custom JSON marshalling embeds
# the payload verbatim. Passing base64 here is accepted silently and then handed
# to the contract AS the message bytes, which fails with
# "unknown variant `eyJ1cGRhdGVfY29uZmln…`" — the base64 text itself quoted back
# (observed 2026-07-29). Verified against the devnet, not assumed.
EXEC_MSG="$(jq -n --arg s "$GOV_POLICY" --arg c "$CONTRACT" --argjson m "$MSG" \
  '{"@type":"/cosmwasm.wasm.v1.MsgExecuteContract",sender:$s,contract:$c,msg:$m,funds:[]}')"

IFS=',' read -r -a VOTER_KEYS <<< "$VOTERS"
PROPOSER="${VOTER_KEYS[0]}"

ID="$(GOV_POLICY="$GOV_POLICY" "$(dirname "${BASH_SOURCE[0]}")/gov-submit.sh" \
  "[$EXEC_MSG]" "devnet: $(echo "$MSG" | jq -r 'keys[0]')" \
  "governed admin call: $MSG" "$PROPOSER")"
[ -n "$ID" ] || { echo "could not resolve the submitted proposal id" >&2; exit 1; }
echo "proposal $ID submitted: $MSG" >&2

for k in "${VOTER_KEYS[@]}"; do
  GOV_POLICY="$GOV_POLICY" "$(dirname "${BASH_SOURCE[0]}")/gov-vote.sh" "$ID" "$k" yes governed >/dev/null
  echo "  voted yes: $k" >&2
done

# `min_execution_period` is 0 on the devnet policies, so exec is immediate — no
# waiting out the voting period for a proposal that already meets threshold.
GOV_POLICY="$GOV_POLICY" "$(dirname "${BASH_SOURCE[0]}")/gov-exec.sh" "$ID" "$PROPOSER" >&2
echo "$ID"
