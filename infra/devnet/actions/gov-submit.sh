#!/usr/bin/env bash
# Usage: gov-submit.sh <messages-json> <title> <summary> [proposer-key[,proposer-key...]]
#
# Submit an x/group proposal against the program's admin policy (app-spec §8.7).
# `<messages-json>` is a proto-JSON ARRAY of sdk.Msgs, inline or `@path`.
#
# Prints the new proposal id on stdout — the drill chains on it.
#
# `proposers` accepts SEVERAL keys on purpose: x/group permits multiple
# proposers, which is exactly why the indexed mirror stores `proposers` as an
# array rather than a scalar (M7.1 plan §4b C1). One proposer is the common
# case, not the only one.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
[ $# -ge 3 ] || {
  echo "usage: $0 <messages-json|@file> <title> <summary> [proposer-key,...]" >&2; exit 1; }

MESSAGES="$1"; TITLE="$2"; SUMMARY="$3"; PROPOSERS="${4:-$FROM}"

case "$MESSAGES" in
  @*) MESSAGES="$(cat "${MESSAGES#@}")" ;;
esac
echo "$MESSAGES" | jq -e 'type == "array"' >/dev/null || {
  echo "messages must be a JSON array of proto-JSON sdk.Msgs" >&2; exit 1; }

resolve_gov_policy

IFS=',' read -r -a PROPOSER_KEYS <<< "$PROPOSERS"
proposer_addrs='['
for i in "${!PROPOSER_KEYS[@]}"; do
  a="$(addr_of "${PROPOSER_KEYS[$i]}")"
  [ -n "$a" ] || { echo "proposer key '${PROPOSER_KEYS[$i]}' not in the keyring" >&2; exit 1; }
  [ "$i" = "0" ] || proposer_addrs+=','
  proposer_addrs+="\"$a\""
done
proposer_addrs+=']'

jq -n \
  --arg policy "$GOV_POLICY" \
  --arg title "$TITLE" \
  --arg summary "$SUMMARY" \
  --argjson messages "$MESSAGES" \
  --argjson proposers "$proposer_addrs" \
  '{group_policy_address:$policy, messages:$messages, metadata:"", title:$title, summary:$summary, proposers:$proposers}' \
  | put_container_file /tmp/nvhash-gov-proposal.json

# The FIRST proposer signs; every listed proposer is recorded on the proposal.
gov_tx "${PROPOSER_KEYS[0]}" -- group submit-proposal /tmp/nvhash-gov-proposal.json >/dev/null

# The proposal id is the highest open id on this policy — read it back rather
# than parsing the tx log, so this works the same on a build whose event
# attributes differ.
qj group proposals-by-group-policy "$GOV_POLICY" \
  | jq -r '[.proposals[]?.id | tonumber] | max // empty'
