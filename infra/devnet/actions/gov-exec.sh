#!/usr/bin/env bash
# Usage: gov-exec.sh <proposal-id> [signer-key]
#
# Execute an ACCEPTED x/group proposal. Anyone may execute — the messages run as
# the POLICY account, not as the signer — so the signer defaults to $FROM.
#
# Prints `status executor_result`. The two are independent: a proposal can be
# ACCEPTED with `executor_result: FAILURE`, which `status` alone cannot express
# and which is exactly why the indexed mirror stores both (M7.1 plan §3.2).
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
[ $# -ge 1 ] || { echo "usage: $0 <proposal-id> [signer-key]" >&2; exit 1; }

ID="$1"; SIGNER_KEY="${2:-$FROM}"
SIGNER="$(addr_of "$SIGNER_KEY")"
[ -n "$SIGNER" ] || { echo "signer key '$SIGNER_KEY' not in the keyring" >&2; exit 1; }

# MsgExec itself succeeds even when the wrapped messages fail — the failure
# lands in `executor_result`, not in the tx code. So this tx committing tells us
# nothing about the outcome; the read-back below is the actual answer.
gov_tx "$SIGNER_KEY" -- group exec "$ID" >/dev/null

# A proposal may be PRUNED the moment it reaches a terminal state, in which case
# the read-back 404s — the chain no longer holds it. That is a real outcome, not
# a script failure, and it is the whole reason the App keeps a durable mirror
# (app-spec §9.1).
if ! out="$(qj group proposal "$ID" 2>/dev/null)"; then
  echo "PRUNED (chain no longer holds proposal $ID)"
  exit 0
fi
echo "$out" | jq -r '"\(.proposal.status) \(.proposal.executor_result)"'
