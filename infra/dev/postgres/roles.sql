-- Two-domain role + schema bootstrap for the dev/test database (ADR-001
-- Decision 1: one PostgreSQL instance, two ownership domains enforced by roles,
-- not convention). Applied idempotently on every full-stack bring-up by
-- infra/devnet/stack.sh and by the app-ci `db-grants` job before the
-- grant-boundary test. Safe to re-run.
--
-- Credentials here are THROWAWAY local-dev values (SECURITY.md, "Development
-- environment": devnet keys/passwords are disposable test material, never
-- reused on any real network). They live only in this dev compose substrate.
--
-- Ownership map (ADR-001 Decision 1):
--   indexed  -> indexer_writer  (sole DDL/DML; the only writer of history)
--   app      -> app_writer      (sessions/alerts/notifications/push; no grants
--                                on indexed of any kind)
--   api_reader -> USAGE + SELECT on indexed only; no write grant anywhere.
--
-- The grant boundary this file establishes is asserted by
-- services/indexer/test/integration/grant-boundary.test.ts, a standing
-- services/* CI gate (plan §4 security-executable layer).

-- Login roles (idempotent — CREATE ROLE has no IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'indexer_writer') THEN
    CREATE ROLE indexer_writer LOGIN PASSWORD 'indexer-dev';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'api_reader') THEN
    CREATE ROLE api_reader LOGIN PASSWORD 'api-dev';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_writer') THEN
    CREATE ROLE app_writer LOGIN PASSWORD 'app-dev';
  END IF;
END
$$;

-- Schemas, each owned by its writer role. Owning the schema is what lets the
-- migration (run AS that role) create tables/types it — and only it — owns.
CREATE SCHEMA IF NOT EXISTS indexed AUTHORIZATION indexer_writer;
CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION app_writer;

-- Reassert ownership in case a schema pre-existed under another owner (e.g. a
-- superuser-run PR 1.1 migration on a reused volume). Determinism matters: the
-- grant-boundary test must see indexer_writer as the owner of `indexed`.
ALTER SCHEMA indexed OWNER TO indexer_writer;
ALTER SCHEMA app OWNER TO app_writer;

-- No ambient rights: PUBLIC gets nothing on either domain schema.
REVOKE ALL ON SCHEMA indexed FROM PUBLIC;
REVOKE ALL ON SCHEMA app FROM PUBLIC;

-- api_reader: read-only visibility into indexed, and nothing else. USAGE lets
-- it resolve objects; SELECT is granted on existing tables now and, via default
-- privileges keyed to indexer_writer, on every table the migration creates
-- afterwards. No INSERT/UPDATE/DELETE is ever granted.
GRANT USAGE ON SCHEMA indexed TO api_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA indexed TO api_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE indexer_writer IN SCHEMA indexed
  GRANT SELECT ON TABLES TO api_reader;

-- The write boundary is enforced by ABSENCE of grants, made explicit here:
--   * app_writer has no USAGE/SELECT on indexed  -> cannot read history.
--   * api_reader has no USAGE on app             -> cannot see app state.
--   * indexer_writer has no USAGE on app         -> the two-reader invariant
--     (ADR-001 Decision 3: only indexer_writer and api_reader touch indexed;
--     the web/notifier tier never does, and the indexer never touches app).
-- These REVOKEs are belt-and-braces against inherited PUBLIC defaults.
REVOKE ALL ON SCHEMA indexed FROM app_writer;
REVOKE ALL ON SCHEMA app FROM api_reader;
REVOKE ALL ON SCHEMA app FROM indexer_writer;
