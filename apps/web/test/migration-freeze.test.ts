// Migration-history freeze gate (PR 8.4a): `20260723000000_init_sessions` is
// frozen migration 0. The app schema is NOT rebuildable from chain — sessions,
// the notification log and push subscriptions exist only here — so history is
// append-only: schema changes are new timestamped migrations from
// `prisma migrate diff --from-migrations --to-schema-datamodel prisma`;
// regenerating or editing the baseline fails here. See
// docs/plans/2026-08-14-app-m8.4a-migration-mode.md §2.6.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const frozenBaseline = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../prisma/migrations/20260723000000_init_sessions/migration.sql",
);

const source = readFileSync(frozenBaseline, "utf8");

describe("frozen migration 0 (app schema)", () => {
  it("is byte-identical to the frozen baseline", () => {
    expect(
      createHash("sha256").update(source).digest("hex"),
      "prisma/migrations/20260723000000_init_sessions is FROZEN history — do not " +
        "regenerate it. Express the schema change as a NEW migration: edit the " +
        "models, then `prisma migrate diff --from-migrations " +
        "--to-schema-datamodel prisma --script` into a new timestamped directory " +
        "(plan 2026-08-14-app-m8.4a §2.6).",
    ).toBe("db1405fd9b18133d87e7f1046a17e4024df6ad40f86a891727df64bf50fae7f7");
  });

  it("carries the hand-written schema-creation guard", () => {
    // `CREATE SCHEMA IF NOT EXISTS` still requires CREATE on the DATABASE,
    // which app_writer does not hold; the existence-checked DO block is the
    // form that works under the role split. It exists only as hand-written SQL.
    expect(source).toContain("IF NOT EXISTS (SELECT FROM pg_namespace WHERE nspname = 'app')");
    expect(source).toContain(`EXECUTE 'CREATE SCHEMA "app"'`);
  });

  it("carries the hand-written partial unique index on live acknowledgments", () => {
    // One LIVE ack per (incident, admin) as a database constraint. It must be
    // PARTIAL — a plain unique would forbid re-acknowledging after a reversal,
    // and Postgres treats NULLs as distinct so an unacknowledgedAt column in a
    // plain unique would enforce nothing. Prisma cannot express a partial
    // unique index, so the statement exists only as this hand-written SQL.
    expect(source).toContain('CREATE UNIQUE INDEX "incident_acks_live_ack_key"');
    expect(source).toContain('WHERE "unacknowledgedAt" IS NULL;');
  });
});
