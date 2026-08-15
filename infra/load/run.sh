#!/usr/bin/env bash
# infra/load/run.sh — the k6 load-suite runner (8.2 §3.2). Driven as
# `./dev load <scenario|all> [k6 args…]`.
#
# DEVNET ONLY (8.2 invariant 3): the target is HARDCODED to the in-network
# `http://api:8080` compose service. Any attempt to point the harness at
# another host is refused — a load tool aimed at a public endpoint is a DoS
# tool, so the property is enforced in the runner, not documented.
#
# The latency scenarios expect the API to run with a RAISED RATE_LIMIT_MAX
# (a latency figure measured while 429s are served is a number about the
# limiter); the rate-limit scenario expects PRODUCTION DEFAULTS. Which config
# produced which number goes in the delivery notes — the two must not blur.
set -euo pipefail

SDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SDIR/../.." && pwd)"
COMPOSE=(docker compose -f "$REPO/infra/dev/compose.yaml")

API_TARGET="http://api:8080"
if [ -n "${API_BASE_URL:-}" ] && [ "${API_BASE_URL}" != "$API_TARGET" ]; then
  echo "run.sh: API_BASE_URL='${API_BASE_URL}' is not the in-network dev service ($API_TARGET) — refusing." >&2
  echo "The load harness targets devnet only (SECURITY.md; 8.2 invariant 3)." >&2
  exit 1
fi

SCENARIOS=(public-mix personal operator internal admin csv-export deep-offset rate-limit)

usage() {
  echo "usage: ./dev load <scenario|all> [k6 args…]" >&2
  echo "scenarios: ${SCENARIOS[*]}" >&2
  exit 1
}

run_one() {
  local scenario="$1"; shift
  local found=0
  for s in "${SCENARIOS[@]}"; do [ "$s" = "$scenario" ] && found=1; done
  [ "$found" = 1 ] || usage
  echo "== k6: $scenario =="
  "${COMPOSE[@]}" --profile load run --rm \
    -e HEAVY_ADDRESS="${HEAVY_ADDRESS:-}" \
    -e HEAVY_VALOPER="${HEAVY_VALOPER:-}" \
    -e HEAVY_OPERATOR="${HEAVY_OPERATOR:-}" \
    -e SUSTAIN="${SUSTAIN:-}" \
    -e RAMP="${RAMP:-}" \
    -e BURST="${BURST:-}" \
    k6 run "/repo/infra/load/${scenario}.js" "$@"
}

CMD="${1:-}"; shift || true
case "$CMD" in
  all)
    for s in "${SCENARIOS[@]}"; do run_one "$s" "$@"; done
    ;;
  "") usage ;;
  *) run_one "$CMD" "$@" ;;
esac
