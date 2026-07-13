#!/usr/bin/env bash
# Usage: purge-jailed.sh <valoper> [claimant_valoper]
# Phase 2 of the jail flow: after the cooldown, move the program's stake off a
# still-jailed validator. With a claimant (caller must be its operator key,
# set FROM accordingly): redelegate up to headroom. Without: full unbond.
#
# Pre-flights the §9.8 preconditions so an obviously-doomed call is diagnosed
# instead of broadcast: the validator must be jailed on chain, a report must
# exist (report-jailed.sh), and the cooldown must have elapsed.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
[ $# -ge 1 ] || { echo "usage: $0 <valoper> [claimant_valoper]" >&2; exit 1; }
resolve

JAILED="$(qj staking validator "$1" 2>/dev/null | jq -r '.validator.jailed // false')"
REPORT="$(smart '{"jail_reports":{}}' ".data.reports[] | select(.valoper==\"$1\")" 2>/dev/null || true)"
NOW="$(date +%s)"
if [ "$JAILED" != "true" ]; then
  echo "cannot purge: $1 is NOT jailed on chain (the two-phase flow only moves" >&2
  echo "stake off a validator that is jailed at BOTH the report and the purge)." >&2
  [ -n "$REPORT" ] && echo "note: a stale report exists; the contract will clear it on the next observation." >&2
  exit 1
fi
if [ -z "$REPORT" ]; then
  echo "cannot purge: $1 is jailed but has no report on file." >&2
  echo "run first:  ./report-jailed.sh $1   (then wait out jail_unbond_delay)" >&2
  exit 1
fi
READY="$(echo "$REPORT" | jq -r '.purge_ready_at_seconds')"
if [ "$NOW" -lt "$READY" ]; then
  echo "cannot purge yet: cooldown active, ready in $((READY - NOW))s (at epoch second $READY)." >&2
  exit 1
fi

if [ $# -ge 2 ]; then
  MSG="{\"purge_jailed_validator\":{\"valoper\":\"$1\",\"claimant_valoper\":\"$2\"}}"
else
  MSG="{\"purge_jailed_validator\":{\"valoper\":\"$1\"}}"
fi
execute "$MSG"
smart '{"jail_reports":{}}'
