// The proposal-template registry gate (M7.3–7.4 §4 invariants 6, 7, 9).
//
// THE INVARIANT THIS FILE EXISTS FOR, and its disproof line: a drift test that
// only checks "every template still matches the contract" catches a template
// that went stale, but NOT an admin variant that never got one — and a new
// admin capability nobody can propose is silently unreachable rather than
// visibly broken. So the mapping is asserted TOTAL IN BOTH DIRECTIONS against
// the committed `cargo schema` output, which is the reviewed interface
// (SECURITY.md "committed schemas"), not against a list restated here.
//
// The schema is read from disk on purpose. A hand-copied variant list in this
// file would be a third place the vocabulary lives, and the whole point of
// invariant 6 is that there is ONE.
//
// READ THE COMMITTED ARTIFACT, NOT A BUILD BYPRODUCT. This gate first read
// `contracts/schema/raw/execute.json`, which is GITIGNORED — it passed on every
// developer machine that had run `cargo schema` and failed CI on a clean
// checkout with `ENOENT`. "The reviewed interface" has to mean a file the repo
// actually carries, so the source is now the tracked bundled IDL.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { decodeMessage, summarizeMessage } from "~/governance/decode";
import {
  configDiffRows,
  MAX_JSON_SAFE_UINT,
  MAX_PAUSE_REASON_LEN,
  PROPOSAL_TEMPLATES,
  templateById,
  templateFieldLines,
  templateInnerJson,
  parseTemplateValues,
  templateSummaryKey,
  toWireTemplateValues,
  TEMPLATE_IDS,
  validateTemplateValues,
  type TemplateValues,
} from "~/governance/templates";
import { t } from "~/i18n";
import { ADMIN_VARIANTS, KEEPER_VARIANTS, OPERATOR_VARIANTS } from "~/tx/build";

const CONTRACT = "tp14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s96lrg8";

// ── The committed contract interface ─────────────────────────────────────

interface SchemaVariant {
  description?: string;
  properties: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
}

/**
 * The BUNDLED IDL, and it must be the bundled one.
 *
 * `cargo schema` writes two things: `contracts/schema/<name>.json` (the IDL,
 * committed) and `contracts/schema/raw/*.json` (per-message, **gitignored** —
 * `.gitignore:6`). This gate first read `raw/execute.json`, which passed
 * locally and failed CI with `ENOENT` on a clean checkout — a gate cannot read
 * authority from a file the repo does not carry. `bundled.execute` is
 * content-identical to `raw/execute.json`, so every assertion below is
 * unchanged; only the source moved to the artifact that is actually reviewed.
 */
const SCHEMA_PATH = resolve(process.cwd(), "../../contracts/schema/nvhash-staking.json");
const executeSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")).execute as {
  oneOf: SchemaVariant[];
};

/** Every `ExecuteMsg` variant, keyed by its serde name. */
const SCHEMA_VARIANTS = new Map(
  executeSchema.oneOf.map((entry) => {
    const name = Object.keys(entry.properties)[0]!;
    return [name, { ...entry, name }] as const;
  }),
);

/**
 * The ADMIN-gated variants, decided by the contract's own doc comments rather
 * than by a list in this repo's TypeScript. `contracts/src/msg.rs` opens every
 * admin variant's comment with "Admin-gated:", and `cargo schema` carries those
 * comments through — so this reads authority from the source of truth.
 */
const SCHEMA_ADMIN_VARIANTS = [...SCHEMA_VARIANTS.values()]
  .filter((entry) => (entry.description ?? "").startsWith("Admin-gated:"))
  .map((entry) => Object.keys(entry.properties)[0]!)
  .sort();

describe("invariant 7 — the template set matches the contract, in both directions", () => {
  it("the committed schema actually carries admin variants (the gate is not vacuous)", () => {
    // A gate that silently found zero admin variants would pass every assertion
    // below while proving nothing. This is the tripwire for that.
    expect(SCHEMA_ADMIN_VARIANTS.length).toBeGreaterThan(0);
    expect(SCHEMA_ADMIN_VARIANTS).toContain("update_config");
  });

  it("every ADMIN variant in the contract has exactly one template", () => {
    // THE DISPROOF CASE. A contract that gains an admin capability with no
    // template fails HERE, rather than shipping an action governance cannot
    // reach. SECURITY.md makes every admin capability a spec-level event; this
    // is that requirement made mechanical.
    expect([...TEMPLATE_IDS].sort()).toEqual(SCHEMA_ADMIN_VARIANTS);
  });

  it("`ADMIN_VARIANTS` agrees with the contract schema", () => {
    // The vocabulary `app/tx/build.ts` publishes — consumed by 7.2's decoder,
    // the rejection matrix and this registry — is pinned to the same source.
    expect([...ADMIN_VARIANTS].sort()).toEqual(SCHEMA_ADMIN_VARIANTS);
  });

  it("no template exists for an operator or keeper variant", () => {
    // Templates carry ADMIN actions only. An operator action reaches the chain
    // directly through M6.4's guard; naming one here would give it a second,
    // governance-shaped route with a different authority.
    for (const variant of [...OPERATOR_VARIANTS, ...KEEPER_VARIANTS]) {
      expect(templateById(variant), variant).toBeNull();
    }
  });

  it("each template's field set is exactly the contract's field set", () => {
    for (const template of PROPOSAL_TEMPLATES) {
      const schema = SCHEMA_VARIANTS.get(template.id);
      expect(schema, template.id).toBeDefined();
      const body = schema!.properties[template.id]!;
      const schemaFields = Object.keys(body.properties ?? {}).sort();
      const templateFields = template.params.map((p) => p.key).sort();
      expect(templateFields, template.id).toEqual(schemaFields);
    }
  });

  it("a template's required/optional split matches the contract's", () => {
    for (const template of PROPOSAL_TEMPLATES) {
      const body = SCHEMA_VARIANTS.get(template.id)!.properties[template.id]!;
      const required = new Set(body.required ?? []);
      for (const param of template.params) {
        // `optionalParams` templates supply none as required (`update_config`'s
        // ten `Option<T>` fields); every other template's fields are required.
        expect(required.has(param.key), `${template.id}.${param.key}`).toBe(
          !template.optionalParams,
        );
      }
    }
  });

  it("every parameter bound is traceable to a contract check", () => {
    // Prose, but MECHANICALLY REQUIRED: §8's stop-and-ask says a bound you
    // cannot trace to a contract check is a stop, not a guess. This asserts the
    // trace exists rather than that it is correct — the specific numbers are
    // pinned individually below.
    for (const template of PROPOSAL_TEMPLATES) {
      for (const param of template.params) {
        expect(param.contractRule.length, `${template.id}.${param.key}`).toBeGreaterThan(20);
      }
    }
  });

  it("pins each bound to the value `Config::validate` enforces", () => {
    // Copied from `contracts/src/state.rs`. If the contract loosens or tightens
    // one, this fails and the template moves in the same change.
    const params = new Map(templateById("update_config")!.params.map((p) => [p.key, p] as const));
    const uintBound = (key: string) => {
      const param = params.get(key)!;
      expect(param.kind).toBe("uint");
      return param as Extract<typeof param, { kind: "uint" }>;
    };
    expect(uintBound("aum_fee_bps").max).toBe(10_000n);
    expect(uintBound("performance_threshold_bps").max).toBe(10_000n);
    expect(uintBound("commission_bps").max).toBe(10_000n);
    // `max_bonded_cap_bps must be in 1..=10000`
    expect(uintBound("max_bonded_cap_bps").min).toBe(1n);
    expect(uintBound("max_bonded_cap_bps").max).toBe(10_000n);
    // `max_concentration_multiple_bps must be > 0`
    expect(uintBound("max_concentration_multiple_bps").min).toBe(1n);
    // `concentration_safety_offset_bps must be < 10000` — strictly below.
    expect(uintBound("concentration_safety_offset_bps").max).toBe(9_999n);
    // The two with no contract check are bounded by JSON-number safety, and
    // that is a stated narrowing rather than an invented ceiling.
    expect(uintBound("min_capture_interval_secs").max).toBe(MAX_JSON_SAFE_UINT);
    expect(uintBound("jail_unbond_delay_secs").max).toBe(MAX_JSON_SAFE_UINT);
    expect(MAX_JSON_SAFE_UINT).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });
});

// ── Canonical output ─────────────────────────────────────────────────────

describe("templateInnerJson — the one canonical serialization site", () => {
  it("produces the contract's own shape for each template", () => {
    expect(templateInnerJson("unpause_vault", {})).toBe(`{"unpause_vault":{}}`);
    expect(templateInnerJson("clear_pending_delegations", {})).toBe(
      `{"clear_pending_delegations":{}}`,
    );
    expect(templateInnerJson("set_halted", { halted: true })).toBe(`{"set_halted":{"halted":true}}`);
    expect(templateInnerJson("set_halted", { halted: false })).toBe(
      `{"set_halted":{"halted":false}}`,
    );
    expect(templateInnerJson("pause_vault", { reason: "emergency stop" })).toBe(
      `{"pause_vault":{"reason":"emergency stop"}}`,
    );
  });

  it("OMITS unsupplied update_config fields rather than sending null", () => {
    // The committed schema lists none of the ten as required, so omission is
    // the shape the contract reads as "do not change this". Emitting explicit
    // nulls would be a second accepted encoding of the same intent, which is
    // exactly what the canonical-bytes guard exists to prevent.
    expect(templateInnerJson("update_config", { aum_fee_bps: 25n })).toBe(
      `{"update_config":{"aum_fee_bps":25}}`,
    );
  });

  it("emits supplied fields in the contract's declaration order, not input order", () => {
    // Key order is part of the canonical form. Building the same instance from
    // differently-ordered input must produce identical bytes, or the guard
    // would reject a proposal the composer itself had just built.
    const a: TemplateValues = { commission_bps: 1_000n, aum_fee_bps: 25n };
    const b: TemplateValues = { aum_fee_bps: 25n, commission_bps: 1_000n };
    expect(templateInnerJson("update_config", a)).toBe(templateInnerJson("update_config", b));
    expect(templateInnerJson("update_config", a)).toBe(
      `{"update_config":{"aum_fee_bps":25,"commission_bps":1000}}`,
    );
  });

  it("round-trips every instance through parseTemplateValues byte-for-byte", () => {
    const instances: { id: string; values: TemplateValues }[] = [
      { id: "unpause_vault", values: {} },
      { id: "clear_pending_delegations", values: {} },
      { id: "set_halted", values: { halted: true } },
      { id: "pause_vault", values: { reason: "x".repeat(MAX_PAUSE_REASON_LEN) } },
      { id: "update_config", values: { aum_fee_bps: 0n } },
      {
        id: "update_config",
        values: {
          max_delegations_per_run: 8n,
          aum_fee_bps: 25n,
          performance_threshold_bps: 9_500n,
          min_capture_interval_secs: 3_600n,
          max_concentration_multiple_bps: 55_000n,
          min_bonded_cap_bps: 500n,
          max_bonded_cap_bps: 3_300n,
          concentration_safety_offset_bps: 500n,
          commission_bps: 1_000n,
          jail_unbond_delay_secs: 28_800n,
        },
      },
    ];
    for (const instance of instances) {
      // Wire shape → domain values → canonical JSON must land back on the same
      // bytes. This is the composer's own path: the form holds wire values, the
      // registry parses them, and the encoder serializes them.
      const json = templateInnerJson(instance.id, instance.values);
      const parsed = parseTemplateValues(instance.id, toWireTemplateValues(instance.values));
      expect(parsed.ok, json).toBe(true);
      if (!parsed.ok) continue;
      expect(templateInnerJson(instance.id, parsed.values)).toBe(json);
    }
  });

  it("throws rather than serializing values it refuses", () => {
    // The `encodeExecuteContract` precedent: callers validate first, and the
    // throw is the backstop that keeps the invariant true however the values
    // were constructed. A silent coercion here would be a canonical form that
    // does not match what the caller asked for.
    expect(() => templateInnerJson("update_config", { aum_fee_bps: 10_001n })).toThrow();
    expect(() => templateInnerJson("set_halted", {})).toThrow();
    expect(() => templateInnerJson("no_such_variant", {})).toThrow();
  });
});

// ── invariant 9: reject, never clamp ─────────────────────────────────────

describe("invariant 9 — reject-never-clamp on every parameter", () => {
  const cases: { label: string; id: string; values: TemplateValues; code: string }[] = [
    { label: "bps above ceiling", id: "update_config", values: { aum_fee_bps: 10_001n }, code: "out-of-range" },
    { label: "offset at its exclusive ceiling", id: "update_config", values: { concentration_safety_offset_bps: 10_000n }, code: "out-of-range" },
    { label: "max bonded cap at zero", id: "update_config", values: { max_bonded_cap_bps: 0n }, code: "out-of-range" },
    { label: "concentration multiple at zero", id: "update_config", values: { max_concentration_multiple_bps: 0n }, code: "out-of-range" },
    { label: "u32 field above its type", id: "update_config", values: { max_delegations_per_run: 4_294_967_296n }, code: "out-of-range" },
    { label: "unknown parameter", id: "update_config", values: { admin: "tp1..." }, code: "unknown-param" },
    { label: "wrong type for a uint", id: "update_config", values: { aum_fee_bps: "25" }, code: "wrong-type" },
    { label: "wrong type for a bool", id: "set_halted", values: { halted: "true" }, code: "wrong-type" },
    { label: "missing required field", id: "set_halted", values: {}, code: "missing-param" },
    { label: "empty pause reason", id: "pause_vault", values: { reason: "" }, code: "length-out-of-range" },
    { label: "over-long pause reason", id: "pause_vault", values: { reason: "x".repeat(MAX_PAUSE_REASON_LEN + 1) }, code: "length-out-of-range" },
    { label: "update_config supplying nothing", id: "update_config", values: {}, code: "no-fields-supplied" },
  ];

  it.each(cases)("$label → $code, and nothing is moved into range", ({ id, values, code }) => {
    const errors = validateTemplateValues(id, values as TemplateValues);
    expect(errors.map((e) => e.code)).toContain(code);
  });

  it("accepts the exact boundary values the contract accepts", () => {
    // The other half of reject-never-clamp: a bound that is one too tight
    // blocks a legitimate proposal, which is a defect in the opposite direction
    // and one no rejection case would catch.
    for (const values of [
      { aum_fee_bps: 10_000n },
      { performance_threshold_bps: 10_000n },
      { commission_bps: 10_000n },
      { max_bonded_cap_bps: 1n },
      { max_bonded_cap_bps: 10_000n },
      { max_concentration_multiple_bps: 1n },
      { concentration_safety_offset_bps: 9_999n },
      { max_delegations_per_run: 4_294_967_295n },
      { aum_fee_bps: 0n },
    ] as TemplateValues[]) {
      expect(validateTemplateValues("update_config", values), JSON.stringify(values, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      )).toEqual([]);
    }
    expect(validateTemplateValues("pause_vault", { reason: "x" })).toEqual([]);
  });

  it("refuses a float, a negative and a string where a uint is declared", () => {
    for (const raw of ["25.5", "-1", "007", " 25", "1e3", "", true]) {
      const parsed = parseTemplateValues("update_config", {
        aum_fee_bps: raw as string | boolean,
      });
      expect(parsed.ok, String(raw)).toBe(false);
    }
  });

  it("refuses an unknown template id and unknown parameter keys", () => {
    expect(parseTemplateValues("no_such_variant", {}).ok).toBe(false);
    // Prototype-shaped keys land on `unknown-param` via the declared-params
    // Map, never on `Object.prototype`.
    for (const key of ["__proto__", "constructor", "toString", "admin"]) {
      const parsed = parseTemplateValues("update_config", { [key]: "1" });
      expect(parsed.ok, key).toBe(false);
    }
  });
});

// ── invariant 6: compose and decode agree ────────────────────────────────

describe("invariant 6 — one vocabulary, three consumers", () => {
  const instances: { id: string; values: TemplateValues }[] = [
    { id: "update_config", values: { aum_fee_bps: 25n, commission_bps: 1_000n } },
    { id: "set_halted", values: { halted: true } },
    { id: "set_halted", values: { halted: false } },
    { id: "pause_vault", values: { reason: "emergency stop" } },
    { id: "unpause_vault", values: {} },
    { id: "clear_pending_delegations", values: {} },
  ];

  it.each(instances)(
    "$id composed by the registry reads back identically through 7.2's decoder",
    ({ id, values }) => {
      // THE ROUND TRIP. A proposal this App composes, mirrored, and read back on
      // its own detail page must be described in the same words — otherwise the
      // App would be the source of a proposal it then summarizes differently,
      // which is the §12.1 "confident wrong summary" failure with the App on
      // both ends of it.
      const decoded = decodeMessage(
        {
          "@type": "/cosmwasm.wasm.v1.MsgExecuteContract",
          contract: CONTRACT,
          msg: JSON.parse(templateInnerJson(id, values)) as Record<string, unknown>,
          funds: [],
        },
        CONTRACT,
      );
      expect(decoded.kind).toBe("program-action");
      if (decoded.kind !== "program-action") return;
      expect(decoded.variant).toBe(id);
      expect(decoded.authority).toBe("admin");

      const composed = templateSummaryKey(id, values);
      expect(summarizeMessage("en", decoded)).toBe(t("en", composed.key, composed.params));
    },
  );

  it("names every supplied update_config field in the composed summary", () => {
    const { key, params } = templateSummaryKey("update_config", {
      aum_fee_bps: 25n,
      commission_bps: 1_000n,
    });
    expect(key).toBe("governance.msg-update-config");
    expect(params["fields"]).toBe("aum_fee_bps, commission_bps");
  });

  it("keeps set_halted's two meanings apart", () => {
    // The one variant whose meaning INVERTS on a field. A single summary
    // covering both would be the invented meaning §12.1 forbids.
    expect(templateSummaryKey("set_halted", { halted: true }).key).toBe(
      "governance.msg-set-halted-on",
    );
    expect(templateSummaryKey("set_halted", { halted: false }).key).toBe(
      "governance.msg-set-halted-off",
    );
  });
});

// ── The config diff (D19) ────────────────────────────────────────────────

describe("configDiffRows — current → proposed, with untouched visibly untouched", () => {
  const current = {
    max_delegations_per_run: 8n,
    aum_fee_bps: 25n,
    performance_threshold_bps: 9_500n,
    min_capture_interval_secs: 3_600n,
    max_concentration_multiple_bps: 55_000n,
    min_bonded_cap_bps: 500n,
    max_bonded_cap_bps: 3_300n,
    concentration_safety_offset_bps: 500n,
    commission_bps: 1_000n,
    jail_unbond_delay_secs: 28_800n,
  };

  it("covers all ten fields on every render", () => {
    const rows = configDiffRows({ aum_fee_bps: 50n }, current);
    expect(rows).toHaveLength(10);
  });

  it("marks a changed field changed and every other field untouched", () => {
    const rows = configDiffRows({ aum_fee_bps: 50n }, current);
    const byKey = new Map(rows.map((r) => [r.key, r] as const));
    expect(byKey.get("aum_fee_bps")).toMatchObject({
      state: "changed",
      current: "25",
      proposed: "50",
    });
    expect(byKey.get("commission_bps")).toMatchObject({
      state: "untouched",
      current: "1000",
      proposed: null,
    });
  });

  it("distinguishes 'not supplied' from 'supplied as the current value'", () => {
    // §2.3's named requirement. The contract's merge makes them equivalent, but
    // they are DIFFERENT MESSAGES on the wire — one omits the key, one sets it
    // — and the proposer is told which they built rather than being shown a
    // diff with an empty row where their own input went.
    const rows = configDiffRows({ aum_fee_bps: 25n }, current);
    const row = rows.find((r) => r.key === "aum_fee_bps")!;
    expect(row.state).toBe("unchanged");
    expect(row.proposed).toBe("25");
  });

  it("renders an unreadable current value as null, never as 0", () => {
    // A failed live `Config {}` read must not become "the current value is 0",
    // which on a bps field reads as a real setting rather than as a gap.
    const rows = configDiffRows({ aum_fee_bps: 50n }, { ...current, aum_fee_bps: null });
    const row = rows.find((r) => r.key === "aum_fee_bps")!;
    expect(row.current).toBeNull();
    // With no current value, "changed" is the honest label — it is being set.
    expect(row.state).toBe("changed");
  });
});

describe("templateFieldLines — supplied parameters only", () => {
  it("lists exactly the supplied fields, in declaration order", () => {
    const lines = templateFieldLines("update_config", {
      commission_bps: 1_000n,
      aum_fee_bps: 25n,
    });
    expect(lines.map((l) => l.key)).toEqual(["aum_fee_bps", "commission_bps"]);
    expect(lines.map((l) => l.value)).toEqual(["25", "1000"]);
  });

  it("is empty for a fieldless template", () => {
    expect(templateFieldLines("unpause_vault", {})).toEqual([]);
  });
});
