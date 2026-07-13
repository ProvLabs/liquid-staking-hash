#!/usr/bin/env bash
# Run the epoch crank (permissionless). Carries flat fees for the x/exchange
# settlement legs; re-run to drain continuation chunks if EpochStatus shows
# pending moves. FROM/CRANK_FEES overridable via env.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
resolve
tx --gas 4000000 --fees "$CRANK_FEES" -- wasm execute "$CONTRACT" '{"run_epoch":{}}'
smart '{"epoch_status":{}}'
