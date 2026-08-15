#!/usr/bin/env bash
# infra/devnet/drills.sh — the degradation-drill driver (8.1 §2.6).
#
#   infra/devnet/drills.sh run       the full sequence below
#   infra/devnet/drills.sh <phase>   one phase, for iteration
#
# Sequence: baseline -> corrupt-row -> repair -> indexer-kill ->
#           indexer-recover -> lcd-kill -> lcd-recover -> bell
#
# The split (Playwright has no Docker socket): THIS script sequences the
# failures on the host; the specs (apps/web/e2e-live/drills/) only observe
# HTTP. Every wait is bounded and FAILS the phase on expiry — no unbounded
# "eventually". A red drill is a finding: never widen a tolerance, threshold
# or wait to make one pass, and never "fix" a drill by re-ingesting or
# restarting outside this declared sequence.
#
# DEVNET ONLY (SECURITY.md): the chain-id guard below refuses any chain
# outside the chain-dev family. The corrupt-row SQL touches the disposable dev
# database only.
set -euo pipefail

SDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SDIR/../.." && pwd)"
COMPOSE=(docker compose -f "$REPO/infra/dev/compose.yaml")
CONTAINER="${CONTAINER:-dev-node}"
API_URL="${API_URL:-http://localhost:8080}"

# DEGRADED_STALE_SECONDS (apps/web chrome, in-code and not env-tunable) plus
# one reconciler cadence: how long indexer-kill waits before observing.
STALE_WAIT_SECONDS="${STALE_WAIT_SECONDS:-360}"

psql_admin() {
  "${COMPOSE[@]}" --profile db exec -T postgres \
    psql -U nvhash -d nvhash -v ON_ERROR_STOP=1 -t -A "$@"
}

guard_devnet() {
  local chain
  chain="$(docker exec "$CONTAINER" provenanced status 2>/dev/null \
    | jq -r '.node_info.network // .NodeInfo.network' || true)"
  case "$chain" in
    chain-dev*) ;;
    *)
      echo "drills.sh: node reports chain-id '$chain', not the chain-dev family — refusing." >&2
      echo "Drills point only at disposable chains (SECURITY.md)." >&2
      exit 1
      ;;
  esac
}

# Run the phase's specs and REQUIRE a non-zero executed count: a drill harness
# whose gate skips inside an active phase would otherwise "pass" empty — the
# C7 disproof for the fail-not-skip rule.
run_phase_spec() {
  local phase="$1" out
  echo "== drill spec: phase $phase =="
  out="$( (cd "$REPO" && E2E_DRILL_PHASE="$phase" ./dev pw --filter @nvhash/web \
    exec playwright test --config playwright.live.config.ts e2e-live/drills/ ) 2>&1)" || {
    echo "$out"
    echo "drills.sh: phase '$phase' spec FAILED" >&2
    exit 1
  }
  echo "$out" | tail -5
  if ! echo "$out" | grep -qE '[1-9][0-9]* passed'; then
    echo "drills.sh: phase '$phase' executed ZERO tests — a skipping drill is silence" >&2
    exit 1
  fi
}

# Poll a SQL predicate until true, bounded; fail the phase on expiry.
wait_sql() {
  local predicate="$1" what="$2" tries="${3:-30}"
  for _ in $(seq 1 "$tries"); do
    if [ "$(psql_admin -c "$predicate")" = "t" ]; then return 0; fi
    sleep 5
  done
  echo "drills.sh: timed out waiting for: $what" >&2
  exit 1
}

contract_address() {
  local vault
  vault="$(docker exec "$CONTAINER" provenanced query vault list -t --home /provenance/nodedev -o json \
    | jq -r '.vaults[0].base_account.address')"
  docker exec "$CONTAINER" provenanced query vault get "$vault" -t --home /provenance/nodedev -o json \
    | jq -r '.vault.asset_manager'
}

latest_chain_epoch() {
  local contract
  contract="$(contract_address)"
  docker exec "$CONTAINER" provenanced query wasm contract-state smart "$contract" \
    '{"epoch_snapshot":{}}' -t --home /provenance/nodedev -o json \
    | jq -r '.data.snapshot.epoch_index'
}

phase_baseline() {
  echo "== phase: baseline (web restarted through stack.sh e2e conventions) =="
  "$SDIR/stack.sh" e2e true # restart web + export prepared-at; run no suite
  run_phase_spec baseline
}

phase_corrupt_row() {
  echo "== phase: corrupt-row =="
  local epoch
  epoch="$(latest_chain_epoch)"
  if [ -z "$epoch" ] || [ "$epoch" = "null" ]; then
    echo "drills.sh: no epoch snapshot on chain — run the epoch drill first" >&2
    exit 1
  fi
  # The chain's LATEST epoch: the reconciler compares only that row, and the
  # epoch-history worker's cursor is already past the crank height, so nothing
  # rewrites this until `repair` — do not "fix" the drill by re-ingesting.
  psql_admin -c "UPDATE indexed.epoch_snapshots SET \"totalShares\" = \"totalShares\" + 1 WHERE \"epochIndex\" = ${epoch};" >/dev/null
  wait_sql "SELECT EXISTS(SELECT 1 FROM indexed.incidents WHERE kind='reconciler_divergence' AND \"closedAt\" IS NULL)" \
    "reconciler_divergence to open (≤ 2 cadences)"
  run_phase_spec corrupt-row
}

phase_repair() {
  echo "== phase: repair =="
  local epoch
  epoch="$(latest_chain_epoch)"
  psql_admin -c "UPDATE indexed.epoch_snapshots SET \"totalShares\" = \"totalShares\" - 1 WHERE \"epochIndex\" = ${epoch};" >/dev/null
  wait_sql "SELECT NOT EXISTS(SELECT 1 FROM indexed.incidents WHERE kind='reconciler_divergence' AND \"closedAt\" IS NULL)" \
    "reconciler_divergence to close"
  run_phase_spec repair
}

phase_indexer_kill() {
  echo "== phase: indexer-kill (waiting ${STALE_WAIT_SECONDS}s past the stale threshold) =="
  "${COMPOSE[@]}" --profile db --profile app stop indexer
  sleep "$STALE_WAIT_SECONDS"
  run_phase_spec indexer-kill
}

phase_indexer_recover() {
  echo "== phase: indexer-recover =="
  "${COMPOSE[@]}" --profile db --profile app start indexer
  # A fresh reconciler pass must land before the banner can clear.
  sleep 45
  run_phase_spec indexer-recover
}

phase_lcd_kill() {
  echo "== phase: lcd-kill =="
  docker stop "$CONTAINER"
  # Give the chrome's live reads time to observe the outage.
  sleep 15
  run_phase_spec lcd-kill
}

phase_lcd_recover() {
  echo "== phase: lcd-recover (proves the restart policy: no hands) =="
  docker start "$CONTAINER"
  # The indexer may have exited on a worker crash; compose's
  # `restart: unless-stopped` must bring it back WITHOUT intervention, and the
  # reconciler's per-pass tolerance must resume the alarm. Bounded wait.
  sleep 90
  local state
  state="$("${COMPOSE[@]}" --profile db --profile app ps --format '{{.Service}} {{.State}}' | grep '^indexer ' || true)"
  case "$state" in
    *running*) ;;
    *)
      echo "drills.sh: indexer is not running after LCD recovery ('$state') — the restart policy failed" >&2
      exit 1
      ;;
  esac
  run_phase_spec lcd-recover
}

phase_bell() {
  echo "== phase: bell (drill → notifier tick → bell) =="
  run_phase_spec bell
}

run_all() {
  phase_baseline
  phase_corrupt_row
  phase_repair
  phase_indexer_kill
  phase_indexer_recover
  phase_lcd_kill
  phase_lcd_recover
  phase_bell
  echo "== drills complete: every phase observed its labeled state =="
}

guard_devnet
CMD="${1:-run}"
case "$CMD" in
  run) run_all ;;
  baseline) phase_baseline ;;
  corrupt-row) phase_corrupt_row ;;
  repair) phase_repair ;;
  indexer-kill) phase_indexer_kill ;;
  indexer-recover) phase_indexer_recover ;;
  lcd-kill) phase_lcd_kill ;;
  lcd-recover) phase_lcd_recover ;;
  bell) phase_bell ;;
  *)
    echo "usage: $0 [run|baseline|corrupt-row|repair|indexer-kill|indexer-recover|lcd-kill|lcd-recover|bell]" >&2
    exit 1
    ;;
esac
