-- Two-domain role + schema bootstrap for a deployed (Cloud SQL) database
-- (ADR-001 Decision 1: one PostgreSQL instance, two ownership domains enforced
-- by roles, not convention). Applied by hand once per environment, before the
-- first sync of any component. Safe to re-run.
--
-- This file contains NO credentials, and cannot: the three domain roles are
-- NOLOGIN. Authentication is Cloud SQL IAM — cloud-sql-proxy runs with
-- --auto-iam-authn and each component connects as its own IAM principal. The
-- domain roles exist only to own objects and carry grants. (Contrast
-- infra/dev/postgres/roles.sql, whose throwaway LOGIN passwords are permitted
-- solely by SECURITY.md's development-environment exception.)
--
-- Ownership map (ADR-001 Decision 1):
--   indexed  -> indexer_writer  (sole DDL/DML; the only writer of history)
--   app      -> app_writer      (sessions/alerts/notifications/push; no grants
--                                on indexed of any kind)
--   api_reader -> USAGE + SELECT on indexed only; no write grant anywhere.
--
-- The boundary this file establishes is asserted by
-- services/indexer/test/integration/grant-boundary.test.ts, which pins the same
-- properties (including table ownership) against the dev substrate.
--
-- PROJECT SUBSTITUTION: replace @provlabs-test with the target project in the
-- IAM principal names below. Cloud SQL IAM users are named for the service
-- account with the `.gserviceaccount.com` suffix removed.

-- Domain roles. NOLOGIN: nothing authenticates as these.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'indexer_writer') THEN
    CREATE ROLE indexer_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'api_reader') THEN
    CREATE ROLE api_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_writer') THEN
    CREATE ROLE app_writer NOLOGIN;
  END IF;
END
$$;

-- Schemas, each owned by its writer role. Owning the schema is what lets a
-- migration running as that role create tables/types it — and only it — owns.
CREATE SCHEMA IF NOT EXISTS indexed AUTHORIZATION indexer_writer;
CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION app_writer;

-- Reassert ownership in case a schema pre-existed under another owner (e.g. an
-- admin-run migration during provisioning). Determinism matters: the ownership
-- assertion in the grant-boundary gate must see indexer_writer.
ALTER SCHEMA indexed OWNER TO indexer_writer;
ALTER SCHEMA app OWNER TO app_writer;

-- No ambient rights: PUBLIC gets nothing on either domain schema.
REVOKE ALL ON SCHEMA indexed FROM PUBLIC;
REVOKE ALL ON SCHEMA app FROM PUBLIC;

-- api_reader: read-only visibility into indexed and nothing else. USAGE lets it
-- resolve objects; SELECT is granted on existing tables now and, via default
-- privileges keyed to indexer_writer, on every table a later migration creates.
-- No INSERT/UPDATE/DELETE is ever granted.
GRANT USAGE ON SCHEMA indexed TO api_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA indexed TO api_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE indexer_writer IN SCHEMA indexed
  GRANT SELECT ON TABLES TO api_reader;

-- The write boundary is enforced by ABSENCE of grants, made explicit here:
--   * app_writer has no USAGE/SELECT on indexed  -> cannot read history.
--   * api_reader has no USAGE on app             -> cannot see app state.
--   * indexer_writer has no USAGE on app         -> the two-reader invariant
--     (ADR-001 Decision 3).
REVOKE ALL ON SCHEMA indexed FROM app_writer;
REVOKE ALL ON SCHEMA app FROM api_reader;
REVOKE ALL ON SCHEMA app FROM indexer_writer;

-- IAM principal -> domain role. The GRANT alone is NOT sufficient. A session
-- authenticating as the IAM principal would still CREATE objects owned by that
-- principal rather than by the domain role, silently breaking the ownership
-- split above: the default privileges are keyed to indexer_writer, so
-- api_reader would not see any table the migration created. `SET role` makes
-- every session for that principal start as the owning role.
GRANT indexer_writer TO "nvhash-indexer@provlabs-test.iam";
ALTER ROLE "nvhash-indexer@provlabs-test.iam" SET role = indexer_writer;

-- The api and web tiers. Their deployments land in their own changes; run the
-- matching pair per component as its principal is provisioned. Kept here so the
-- whole boundary is described in one place rather than discovered per service.
-- GRANT api_reader TO "nvhash-api@provlabs-test.iam";
-- ALTER ROLE "nvhash-api@provlabs-test.iam" SET role = api_reader;
-- GRANT app_writer TO "nvhash-web@provlabs-test.iam";
-- ALTER ROLE "nvhash-web@provlabs-test.iam" SET role = app_writer;
