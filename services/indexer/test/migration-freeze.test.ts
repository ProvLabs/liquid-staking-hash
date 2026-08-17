// Migration-history freeze gate (PR 8.4a): `20260715013707_init` is frozen
// migration 0. Schema changes append a new timestamped migration produced with
// `prisma migrate diff --from-migrations --to-schema-datamodel prisma`;
// regenerating or editing the baseline rewrites history other environments
// have already applied and fails here. See
// docs/plans/2026-08-14-app-m8.4a-migration-mode.md §2.6.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const frozenBaseline = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../prisma/migrations/20260715013707_init/migration.sql",
);

const source = readFileSync(frozenBaseline, "utf8");

describe("frozen migration 0 (indexed schema)", () => {
  it("is byte-identical to the frozen baseline", () => {
    expect(
      createHash("sha256").update(source).digest("hex"),
      "prisma/migrations/20260715013707_init is FROZEN history — do not regenerate it. " +
        "Express the schema change as a NEW migration: edit the models, then " +
        "`prisma migrate diff --from-migrations --to-schema-datamodel prisma --script` " +
        "into a new timestamped directory (plan 2026-08-14-app-m8.4a §2.6).",
    ).toBe("a7f8b769e2ea865b9b8dcb150452d30533a04b7eca79e32680c8d2e0e4609be2");
  });

  it("carries the hand-written proposers NOT NULL constraint", () => {
    // x/group requires at least one proposer and the generated client types the
    // list as required; a list column's nullability is not a Prisma datamodel
    // property, so the constraint exists only as this hand-written SQL. Any
    // future migration touching gov_proposals.proposers must preserve it.
    expect(source).toContain(
      'ALTER TABLE "indexed"."gov_proposals" ALTER COLUMN "proposers" SET NOT NULL;',
    );
  });
});
