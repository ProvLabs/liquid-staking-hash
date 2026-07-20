#!/usr/bin/env bash
# infra/devnet/stack.sh — local full-stack wiring (app plan PR 1.5).
#
# One command to bring up Postgres + indexer + api + web against the dev node:
#
#   infra/devnet/stack.sh up        dev node (+ resolve contract) -> postgres ->
#                                   roles/schemas -> migrate -> indexer/api/web,
#                                   waiting until every component is healthy
#   infra/devnet/stack.sh verify    run the grant-boundary gate + show health
#   infra/devnet/stack.sh status    compose status + health of each component
#   infra/devnet/stack.sh logs      follow the app services' logs
#   infra/devnet/stack.sh down      stop the app services (dev node + postgres
#                                   volume are left intact; add `--all` to also
#                                   stop postgres)
#
# DEVNET ONLY (SECURITY.md "Development environment"): this targets the
# disposable local chain and throwaway local-dev database credentials, nothing
# else. The web tier's boot check refuses to serve if the chain it is pointed at
# does not match its configured environment, so a stray non-devnet endpoint
# fails closed rather than silently serving.
#
# The compose service definitions live in infra/dev/compose.yaml (ADR-002); this
# script only does the chain/DB ordering they depend on. All JS work runs in the
# pinned tools container, never on the host.
set -euo pipefail

SDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SDIR/../.." && pwd)"
COMPOSE=(docker compose -f "$REPO/infra/dev/compose.yaml")
NETWORK="nvhash-dev"

# Overridable to match dev-node.sh; defaults are the drill environment.
CONTAINER="${CONTAINER:-dev-node}"
DEVNET_HOME="${HOME_DIR:-/provenance/nodedev}"
SHARE="${SHARE:-nvhash}"
INDEXER_WRITER_URL="postgresql://indexer_writer:indexer-dev@postgres:5432/nvhash?schema=indexed"

ensure_network() {
  docker network inspect "$NETWORK" >/dev/null 2>&1 \
    || docker network create "$NETWORK" >/dev/null
}

# Resolve the deployed vault + asset-manager contract from chain state (same
# path as infra/devnet/actions/_common.sh). Exports CONTRACT_ADDRESS,
# VAULT_ADDRESS, CHAIN_ID for compose interpolation.
resolve_addresses() {
  local vault contract
  vault="$(docker exec "$CONTAINER" provenanced query vault list \
    -t --home "$DEVNET_HOME" -o json 2>/dev/null \
    | jq -r --arg d "$SHARE" \
      '.vaults[]?|select(.total_shares.denom==$d)|.base_account.address' \
    | head -1)"
  if [ -z "$vault" ] || [ "$vault" = "null" ]; then
    echo "no vault found for share denom '$SHARE'." >&2
    echo "The dev node is up but not bootstrapped; deploy the contract first:" >&2
    echo "  infra/devnet/dev-node.sh bootstrap" >&2
    exit 1
  fi
  contract="$(docker exec "$CONTAINER" provenanced query vault get "$vault" \
    -t --home "$DEVNET_HOME" -o json 2>/dev/null | jq -r '.vault.asset_manager')"
  if [ -z "$contract" ] || [ "$contract" = "null" ]; then
    echo "vault $vault has no asset manager set; re-run the bootstrap." >&2
    exit 1
  fi
  export VAULT_ADDRESS="$vault"
  export CONTRACT_ADDRESS="$contract"
  export CHAIN_ID="${CHAIN_ID:-chain-dev}"
}

psql_admin() {
  "${COMPOSE[@]}" --profile db exec -T postgres \
    psql -U nvhash -d nvhash -v ON_ERROR_STOP=1 "$@"
}

up() {
  ensure_network

  # 1. Dev node — start it if it is not already running (does not bootstrap;
  #    resolve_addresses reports if the contract is missing).
  if [ -z "$(docker ps -q -f "name=^${CONTAINER}$")" ]; then
    echo "== dev node not running; starting it =="
    "$SDIR/dev-node.sh" up
  fi
  echo "== resolving deployed vault + contract from chain =="
  resolve_addresses
  echo "   CHAIN_ID=$CHAIN_ID"
  echo "   VAULT_ADDRESS=$VAULT_ADDRESS"
  echo "   CONTRACT_ADDRESS=$CONTRACT_ADDRESS"

  # 2. Postgres.
  echo "== starting dev postgres =="
  "${COMPOSE[@]}" --profile db up -d --wait postgres

  # 3. Roles + schemas (idempotent), then migrate the indexed schema AS
  #    indexer_writer so it owns every table (ADR-001 Decision 1).
  echo "== applying role/schema boundary (infra/dev/postgres/roles.sql) =="
  psql_admin -f - < "$REPO/infra/dev/postgres/roles.sql" >/dev/null
  echo "== migrating the indexed schema (as indexer_writer) =="
  "${COMPOSE[@]}" run --rm -e DATABASE_URL="$INDEXER_WRITER_URL" tools \
    corepack pnpm --filter @nvhash/indexer run migrate:deploy
  # Belt-and-braces: grant SELECT on anything already present (e.g. the Prisma
  # migrations table) — new tables inherit SELECT via roles.sql default privs.
  psql_admin -c "GRANT SELECT ON ALL TABLES IN SCHEMA indexed TO api_reader;" >/dev/null

  # 4. App services, waiting until each reports healthy.
  echo "== starting indexer + api + web (waiting for health) =="
  "${COMPOSE[@]}" --profile db --profile app up -d --wait --wait-timeout 300

  echo
  echo "== stack up =="
  status
  echo
  echo "   web : http://localhost:3000   (SSR, live reads against the dev node)"
  echo "   api : http://localhost:8080/api/v1/health"
  echo "   run 'infra/devnet/stack.sh verify' to exercise the grant-boundary gate"
}

verify() {
  echo "== grant-boundary integration test (ADR-001 Decision 1) =="
  "${COMPOSE[@]}" run --rm tools \
    corepack pnpm --filter @nvhash/indexer run test:grants
  echo
  echo "== component health =="
  status
}

status() {
  "${COMPOSE[@]}" --profile db --profile app ps
}

logs() {
  "${COMPOSE[@]}" --profile app logs -f indexer api web
}

down() {
  if [ "${1:-}" = "--all" ]; then
    echo "== stopping app services + postgres =="
    "${COMPOSE[@]}" --profile db --profile app down
  else
    echo "== stopping app services (postgres + dev node left running) =="
    # Both profiles are enabled so the indexer's depends_on: postgres reference
    # resolves; `rm` still targets only the three app services, leaving the
    # postgres container (and its volume) up.
    "${COMPOSE[@]}" --profile db --profile app rm -sf indexer api web
  fi
}

CMD="${1:-up}"; shift || true
case "$CMD" in
  up) up ;;
  verify) verify ;;
  status) status ;;
  logs) logs ;;
  down) down "$@" ;;
  *)
    echo "usage: $0 [up|verify|status|logs|down [--all]]" >&2
    exit 1
    ;;
esac
