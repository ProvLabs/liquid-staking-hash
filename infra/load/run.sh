#!/usr/bin/env bash
# infra/load/run.sh — the k6 load-suite runner (8.2 §3.2). Driven as
# `./dev load <scenario|all> [k6 args…]`.
#
# Devnet only (8.2 invariant 3): target hardcoded in-network; a public-endpoint
# load tool is a DoS tool.
#
# Latency scenarios need the raised RATE_LIMIT_MAX, rate-limit the production
# default (8.2 §2.3); every run preflights the live value.
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

# Raised = config.ts upper bound; default = compose/production RATE_LIMIT_MAX.
LATENCY_LIMIT=100000
PROD_LIMIT=120

usage() {
  echo "usage: ./dev load <scenario|all> [k6 args…]" >&2
  echo "scenarios: ${SCENARIOS[*]}" >&2
  exit 1
}

expected_limit() {
  case "$1" in
    rate-limit) echo "$PROD_LIMIT" ;;
    *) echo "$LATENCY_LIMIT" ;;
  esac
}

# Every response carries `ratelimit-limit` (stamped before route match), so this reads the live config.
api_limit() {
  "${COMPOSE[@]}" --profile app exec -T api node -e \
    "fetch('http://127.0.0.1:8080/api/v1/health').then((r)=>{console.log(r.headers.get('ratelimit-limit'))}).catch(()=>process.exit(1))"
}

# Refuse a scenario whose required limiter profile does not match the running API.
preflight() {
  local scenario="$1" want got
  want="$(expected_limit "$scenario")"
  if ! got="$(api_limit)"; then
    echo "run.sh: cannot read the api service's rate-limit config (is the app stack up?)" >&2
    exit 1
  fi
  if [ "$got" != "$want" ]; then
    echo "run.sh: api advertises ratelimit-limit=$got but scenario '$scenario' requires $want; refusing." >&2
    echo "restart it: RATE_LIMIT_MAX=$want docker compose -f infra/dev/compose.yaml --profile app up -d --wait api" >&2
    echo "(or use './dev load all', which switches profiles itself)" >&2
    exit 1
  fi
}

# Recreate the api service with the given RATE_LIMIT_MAX and wait for health.
set_api_limit() {
  echo "== api: RATE_LIMIT_MAX=$1 =="
  RATE_LIMIT_MAX="$1" "${COMPOSE[@]}" --profile app up -d --wait api
}

run_one() {
  local scenario="$1"; shift
  local found=0
  for s in "${SCENARIOS[@]}"; do [ "$s" = "$scenario" ] && found=1; done
  [ "$found" = 1 ] || usage
  preflight "$scenario"
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
    set_api_limit "$LATENCY_LIMIT"
    for s in "${SCENARIOS[@]}"; do
      [ "$s" = "rate-limit" ] && continue
      run_one "$s" "$@"
    done
    set_api_limit "$PROD_LIMIT"
    run_one rate-limit "$@"
    ;;
  "") usage ;;
  *) run_one "$CMD" "$@" ;;
esac
