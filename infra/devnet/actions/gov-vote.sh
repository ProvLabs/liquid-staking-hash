#!/usr/bin/env bash
# Usage: gov-vote.sh <proposal-id> <voter-key> <yes|no|abstain|no_with_veto> [metadata]
#
# Cast an x/group vote. `--exec` is deliberately NOT passed: a vote that also
# executes hides the tally-then-execute sequence the App renders as two distinct
# states, and the M7.3–7.4 relay guard pins `MsgVote.exec` to
# EXEC_TRY_UNSPECIFIED for the same reason. Execution is `gov-exec.sh`.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
[ $# -ge 3 ] || {
  echo "usage: $0 <proposal-id> <voter-key> <yes|no|abstain|no_with_veto> [metadata]" >&2; exit 1; }

ID="$1"; VOTER_KEY="$2"; OPTION="$3"; META="${4:-}"

# The CLI takes the FULL proto enum name — `yes` is rejected outright. Mapping
# it here keeps the drill and the action scripts reading in the App's own
# vocabulary while the wire value stays exactly what the chain stores.
case "$OPTION" in
  yes|VOTE_OPTION_YES) OPTION=VOTE_OPTION_YES ;;
  no|VOTE_OPTION_NO) OPTION=VOTE_OPTION_NO ;;
  abstain|VOTE_OPTION_ABSTAIN) OPTION=VOTE_OPTION_ABSTAIN ;;
  no_with_veto|VOTE_OPTION_NO_WITH_VETO) OPTION=VOTE_OPTION_NO_WITH_VETO ;;
  *) echo "option must be one of: yes no abstain no_with_veto" >&2; exit 1 ;;
esac

VOTER="$(addr_of "$VOTER_KEY")"
[ -n "$VOTER" ] || { echo "voter key '$VOTER_KEY' not in the keyring" >&2; exit 1; }

gov_tx "$VOTER_KEY" -- group vote "$ID" "$VOTER" "$OPTION" "$META" >/dev/null

qj group tally-result "$ID" | jq -c '.tally'
