// Grant-boundary integration test (ADR-001 Decision 1, action item 4).
// This is the mechanism — not a caller/topology assumption — that
// makes the two-domain ownership split a control SECURITY.md can rely on. It
// runs against a live Postgres that infra/dev/postgres/roles.sql has bootstrapped
// and the indexer's Prisma migration has populated, then asserts the exact
// boundary ADR-001 specifies:
//
//   * api_reader  — may SELECT indexed, may NOT INSERT/UPDATE any indexed table.
//   * app_writer  — may NOT SELECT any indexed table (no read into history).
//   * indexer_writer — has NO privileges on the `app` schema (the two-reader
//     invariant, ADR-001 Decision 3).
//
// It is a standing gate: the app-ci `db-grants` job runs it on every PR, and
// infra/devnet/stack.sh runs it during full-stack verification. A regression in
// roles.sql (e.g. granting api_reader a write, or app_writer a read) fails here.
//
// Roles are exercised via SET ROLE from a superuser connection, so the assertion
// reflects each role's real privilege set without depending on login passwords.
// SET ROLE to a non-superuser role enforces that role's grants exactly.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

// A superuser connection is required to SET ROLE across the three roles. Defaults
// to the dev/CI Postgres superuser; override via ADMIN_DATABASE_URL.
const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ?? "postgresql://nvhash:nvhash-dev@postgres:5432/nvhash";

// A known indexed table the migration creates (app-spec §9.1). Fully qualified
// so the assertions do not depend on any role's search_path.
const INDEXED_TABLE = "indexed.transactions";

let client: Client;

/** Run `fn` under the privileges of `role`, always restoring the superuser. */
async function asRole<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await client.query(`SET ROLE ${role}`);
  try {
    return await fn();
  } finally {
    await client.query("RESET ROLE");
  }
}

beforeAll(async () => {
  client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  // Guard: the boundary is meaningless if the schema was never migrated.
  const { rows } = await client.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [INDEXED_TABLE],
  );
  if (!rows[0]?.exists) {
    throw new Error(
      `${INDEXED_TABLE} is absent — apply infra/dev/postgres/roles.sql and run ` +
        `the indexer migration (migrate:deploy as indexer_writer) before this test.`,
    );
  }
});

afterAll(async () => {
  await client?.end();
});

describe("indexed/app grant boundary (ADR-001 Decision 1)", () => {
  it("api_reader may SELECT from indexed", async () => {
    await asRole("api_reader", async () => {
      // Zero rows is fine — the point is that SELECT is permitted, not denied.
      await expect(client.query(`SELECT 1 FROM ${INDEXED_TABLE} LIMIT 1`)).resolves.toBeDefined();
    });
  });

  it("api_reader may NOT INSERT into indexed (read-only role)", async () => {
    await asRole("api_reader", async () => {
      await expect(
        client.query(
          `INSERT INTO ${INDEXED_TABLE} ` +
            `("txhash","msgIndex","address","kind","shares","nhash","navAtHeight","height","blockTime") ` +
            `VALUES ('x',0,'tp1x','swap_in',0,0,0,0, now())`,
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it("api_reader may NOT UPDATE indexed (read-only role)", async () => {
    await asRole("api_reader", async () => {
      await expect(client.query(`UPDATE ${INDEXED_TABLE} SET "address" = 'tp1y'`)).rejects.toThrow(
        /permission denied/i,
      );
    });
  });

  it("app_writer may NOT SELECT from indexed (no read into history)", async () => {
    await asRole("app_writer", async () => {
      await expect(client.query(`SELECT 1 FROM ${INDEXED_TABLE} LIMIT 1`)).rejects.toThrow(
        /permission denied/i,
      );
    });
  });

  it("indexer_writer has NO privileges on the app schema (two-reader invariant)", async () => {
    // Catalog-level assertion: independent of whether app tables exist yet
    // (app-schema Prisma lands with the session/alert PRs). indexer_writer must
    // hold neither USAGE nor CREATE on `app`.
    const { rows } = await client.query<{ usage: boolean; create: boolean }>(
      "SELECT has_schema_privilege('indexer_writer','app','USAGE') AS usage, " +
        "has_schema_privilege('indexer_writer','app','CREATE') AS create",
    );
    expect(rows[0]?.usage).toBe(false);
    expect(rows[0]?.create).toBe(false);
  });

  it("api_reader has NO privileges on the app schema", async () => {
    const { rows } = await client.query<{ usage: boolean }>(
      "SELECT has_schema_privilege('api_reader','app','USAGE') AS usage",
    );
    expect(rows[0]?.usage).toBe(false);
  });
});
