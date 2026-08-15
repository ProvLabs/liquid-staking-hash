#!/usr/bin/env bash
# Per-environment database provisioning (plan 8.4 §2.3.1): the SAME statements
# as infra/dev/postgres/roles.sql, with the throwaway dev literals replaced by
# per-environment credentials read FROM THE SECRET STORE at run time. The
# grants are unchanged (ADR-001 Decision 1): indexer_writer owns `indexed`,
# app_writer owns `app`, api_reader is SELECT-only via default privileges,
# PUBLIC gets nothing. Runs as the ArgoCD wave-0 Job; wave 2's grant-verify
# Job asserts the boundary it establishes.
#
# FAIL-CLOSED (§4 invariant 3): every credential must be present, non-empty,
# and non-placeholder BEFORE any statement runs — there is no --force and no
# interactive continue. Expected environment (from ExternalSecret-backed env):
#   PROVISION_DATABASE_URL   admin connection able to CREATE ROLE/SCHEMA
#   INDEXER_WRITER_PASSWORD  indexer_writer login password
#   API_READER_PASSWORD      api_reader login password
#   APP_WRITER_PASSWORD      app_writer login password
set -euo pipefail

refuse() {
  echo "provision-roles: $1 — refusing before any side effect (D24 fail-closed)" >&2
  exit 1
}

is_placeholder() {
  local lower
  lower="$(tr '[:upper:]' '[:lower:]' <<<"$1")"
  [[ "$lower" =~ (placeholder|not-a-secret|example|change-?me|replace|sentinel|throwaway|xxxx) ]]
}

for var in PROVISION_DATABASE_URL INDEXER_WRITER_PASSWORD API_READER_PASSWORD APP_WRITER_PASSWORD; do
  value="${!var:-}"
  [[ -n "$value" ]] || refuse "$var is unset or empty"
  if is_placeholder "$value"; then refuse "$var matches a placeholder pattern"; fi
done
for var in INDEXER_WRITER_PASSWORD API_READER_PASSWORD APP_WRITER_PASSWORD; do
  [[ "${#var}" -ge 0 && "${!var}" =~ ^.{16,}$ ]] || refuse "$var is shorter than 16 characters"
done

# psql -v substitution keeps the passwords out of the SQL text and out of any
# argv a process listing could read; ON_ERROR_STOP keeps a partial apply from
# reading as success.
psql "$PROVISION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v indexer_pw="$INDEXER_WRITER_PASSWORD" \
  -v api_pw="$API_READER_PASSWORD" \
  -v app_pw="$APP_WRITER_PASSWORD" <<'SQL'
-- Login roles (idempotent — CREATE ROLE has no IF NOT EXISTS). Passwords are
-- ALWAYS (re)applied so a store rotation lands on the next provision run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'indexer_writer') THEN
    CREATE ROLE indexer_writer LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'api_reader') THEN
    CREATE ROLE api_reader LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_writer') THEN
    CREATE ROLE app_writer LOGIN;
  END IF;
END
$$;
ALTER ROLE indexer_writer LOGIN PASSWORD :'indexer_pw';
ALTER ROLE api_reader LOGIN PASSWORD :'api_pw';
ALTER ROLE app_writer LOGIN PASSWORD :'app_pw';

-- Schemas, ownership, and the grant boundary — identical to
-- infra/dev/postgres/roles.sql (one source of semantics, two credential
-- postures; the grant-boundary test asserts both).
CREATE SCHEMA IF NOT EXISTS indexed AUTHORIZATION indexer_writer;
CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION app_writer;
ALTER SCHEMA indexed OWNER TO indexer_writer;
ALTER SCHEMA app OWNER TO app_writer;
REVOKE ALL ON SCHEMA indexed FROM PUBLIC;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA indexed TO api_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA indexed TO api_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE indexer_writer IN SCHEMA indexed
  GRANT SELECT ON TABLES TO api_reader;
REVOKE ALL ON SCHEMA indexed FROM app_writer;
REVOKE ALL ON SCHEMA app FROM api_reader;
REVOKE ALL ON SCHEMA app FROM indexer_writer;
SQL

echo "provision-roles: role split applied"
