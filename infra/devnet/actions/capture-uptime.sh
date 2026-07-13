#!/usr/bin/env bash
# Fold every enrolled validator's live signed-blocks ratio into the epoch
# uptime accumulator (permissionless; interval-gated no-op when called early).
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
execute '{"capture_uptime_signal":{}}'
smart '{"validators":{}}' '[.data.validators[] | {valoper, uptime_bps: (.uptime_bps // "n/a (no signal)"), uptime_capture_count}]'
