# Deployed database bootstrap

`roles.sql` establishes the ADR-001 Decision 1 two-domain ownership split on a
deployed (Cloud SQL) instance. Apply it **once per environment, before the first
component sync**.

Authentication is Cloud SQL IAM, so this file holds no credentials: the three
domain roles are `NOLOGIN` and exist only to own objects and carry grants. Each
component authenticates as its own IAM principal through `cloud-sql-proxy
--auto-iam-authn` and inherits its domain role.

## Applying it

Connect through the proxy as an instance admin, substitute the project in the
IAM principal names, then:

    psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f infra/cloudsql/roles.sql

The file is idempotent and safe to re-run. Run the commented `GRANT` /
`ALTER ROLE` pair for the api and web principals as those components are
provisioned.

## The line that is easy to miss

`ALTER ROLE "<principal>" SET role = <domain_role>` is not redundant with the
`GRANT`. Without it, a session authenticating as the IAM principal creates
objects owned by that principal rather than by the domain role — the schema
looks fine, the service runs, and `api_reader` silently cannot see any table
created afterwards, because the default privileges are keyed to
`indexer_writer`.

## Relationship to `infra/dev/postgres/roles.sql`

The dev file is the same boundary with `LOGIN` roles and throwaway passwords,
permitted only by SECURITY.md's development-environment exception. The two must
express the same ownership map and grant set.

**Only the dev file is exercised by CI** — the grant-boundary gate
(`services/indexer/test/integration/grant-boundary.test.ts`, run by the
`db-grants` job) asserts the boundary and table ownership against the dev
substrate. Nothing in CI can observe a deployed instance, so keeping this file
in agreement is a review obligation, not a gated one.

That gap is recorded in
[ADR-003](../../docs/architecture/2026-08-17-adr-003-deployment-topology.md)
(Consequences) and tracked as **CO-55** in the M8 milestone overview's decision
register. It needs a named owner rather than silent inheritance.
