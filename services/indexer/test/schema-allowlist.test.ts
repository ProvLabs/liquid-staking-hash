// Security-executable gate (a): the `indexed` schema carries no column outside
// the SECURITY.md allowed-fields list — no PII, no IP/device identifiers.
// Standing in CI from PR 1.1 on (runs under `pnpm -r test`). A deliberate
// violation (e.g. adding an `ipAddress` column) makes this suite — and CI —
// fail.

import { describe, expect, it } from "vitest";
import { parseModels } from "./security/parse-prisma.ts";
import { ALLOWED_FIELDS, AMOUNT_FIELDS, FORBIDDEN_FIELD_SUBSTRINGS } from "./security/allowed-fields.ts";

const models = parseModels();

describe("indexed schema field allowlist (SECURITY.md data minimization)", () => {
  it("parses at least the twelve indexed models", () => {
    // Guards against a parser regression silently passing an empty schema.
    expect(models.length).toBeGreaterThanOrEqual(12);
  });

  it("every model is covered by the allowlist", () => {
    const uncovered = models.map((m) => m.name).filter((name) => !(name in ALLOWED_FIELDS));
    expect(uncovered, `models missing from allowed-fields.ts (design-review required): ${uncovered.join(", ")}`).toEqual(
      [],
    );
  });

  it("every column is on its model's allowlist", () => {
    const violations: string[] = [];
    for (const model of models) {
      const allowed = ALLOWED_FIELDS[model.name] ?? [];
      for (const field of model.fields) {
        if (!allowed.includes(field.name)) {
          violations.push(`${model.name}.${field.name}`);
        }
      }
    }
    expect(
      violations,
      `columns outside the SECURITY.md allowed-fields list (add to allowed-fields.ts only after data-minimization review): ${violations.join(
        ", ",
      )}`,
    ).toEqual([]);
  });

  it("no column name matches a forbidden PII / IP / device substring", () => {
    const violations: string[] = [];
    for (const model of models) {
      for (const field of model.fields) {
        const lowered = field.name.toLowerCase();
        for (const forbidden of FORBIDDEN_FIELD_SUBSTRINGS) {
          if (lowered.includes(forbidden)) {
            violations.push(`${model.name}.${field.name} (matched "${forbidden}")`);
          }
        }
      }
    }
    expect(violations, `forbidden identity/IP/device columns: ${violations.join(", ")}`).toEqual([]);
  });
});

describe("amount discipline (app-spec §5.8: Decimal(39,0), never a JS number)", () => {
  it("every amount-shaped column is Decimal @db.Decimal(39, 0)", () => {
    const byName = new Map(models.map((m) => [m.name, m]));
    const violations: string[] = [];
    for (const [modelName, amountFields] of Object.entries(AMOUNT_FIELDS)) {
      const model = byName.get(modelName);
      expect(model, `amount-bearing model ${modelName} not found`).toBeDefined();
      for (const fieldName of amountFields) {
        const field = model!.fields.find((f) => f.name === fieldName);
        expect(field, `${modelName}.${fieldName} declared as amount but absent from schema`).toBeDefined();
        const ok = field!.type === "Decimal" && /@db\.Decimal\(\s*39\s*,\s*0\s*\)/.test(field!.attributes);
        if (!ok) violations.push(`${modelName}.${fieldName} → ${field!.type} ${field!.attributes}`);
      }
    }
    expect(violations, `amount columns not typed Decimal(39,0): ${violations.join(", ")}`).toEqual([]);
  });

  it("no indexed column uses Float (floating point is banned on amounts)", () => {
    const floats: string[] = [];
    for (const model of models) {
      for (const field of model.fields) {
        if (field.type === "Float") floats.push(`${model.name}.${field.name}`);
      }
    }
    expect(floats, `Float columns are forbidden: ${floats.join(", ")}`).toEqual([]);
  });
});
