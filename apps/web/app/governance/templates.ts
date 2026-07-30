// The CLOSED proposal-template registry (M7.3–7.4 §2.3; app-spec §8.7, §14.6).
// PURE — no I/O, no clock, no config. Runs unchanged in the browser bundle
// (the composer form imports it) AND on the server (the relay guard does).
//
// WHAT THIS FILE IS — AND IS NOT, since it briefly was something else. This is
// the COMPOSER'S vocabulary: it is what makes proposal creation
// "template-scoped" per app-spec §8.7, which asks the App to offer decoded
// templates of the program's admin actions rather than free-form message
// building (free-form stays a Console strength).
//
// It is NOT a relay guard input. The 2026-07-30 revision of the §12.3
// amendment removed the guard's per-inner-message template matching: a proposal
// executes nothing until the group's decision policy is satisfied by members
// voting, so restricting what may be PROPOSED reduced no authority while
// costing a live chain read and a registry the relay had to keep in lockstep
// with the contract. What protects members from a hostile proposal is being
// able to READ it before voting — `app/governance/decode.ts`, which summarizes
// a closed union and tags everything else `unknown` with the exact JSON.
//
// ONE VOCABULARY, THREE CONSUMERS (§2.3, invariant 6) — still true, and still
// the reason this is one file:
//
//   * `app/governance/decode.ts` (7.2) READS proposals containing these
//     messages — through `ADMIN_VARIANTS`, which this file keys off, so a
//     proposal composed here and read back there cannot be described
//     differently;
//   * the confirm step DISCLOSES them;
//   * the composer BUILDS them.
//
// A template exists for EVERY admin variant in `contracts/src/msg.rs` and for
// no other variant. `test/governance-templates.test.ts` asserts that mapping is
// total in BOTH directions against the committed `cargo schema` output
// (`contracts/schema/raw/execute.json`). That gate is now a PRODUCT
// completeness property rather than a security one: a contract that gains an
// admin capability fails CI here rather than leaving it unreachable from the
// App's composer.
//
// BRIDGE CONFIG IS ABSENT, NOT STUBBED (§7 Q1, confirmed 2026-07-30). App-spec
// §8.7 names it, but it depends on §14.3 (external, NUVA) and no contract
// variant backs it. An absent template is honest; a disabled one invites "when".

// IMPORTS ARE TYPE-ONLY. `app/tx/build.ts` imports `templateInnerJson` from
// here at runtime to encode a composed proposal's inner messages, and build.ts
// keeps a deliberately narrow import surface because the relay decodes
// UNTRUSTED bytes through it — so a value import of `t` and its catalogs would
// drag the i18n catalogs into that graph, and one of `ADMIN_VARIANTS` would
// cycle. Templates therefore carry i18n KEYS, never translated strings, and the
// totality of the template ↔ `ADMIN_VARIANTS` mapping is asserted in
// `test/governance-templates.test.ts` rather than here.
import type { AdminVariant } from "~/tx/build";
import type { MessageKey } from "~/i18n";

/**
 * The largest integer this builder will serialize as a JSON number.
 *
 * A REPRESENTATION bound, and narrower than the contract's `u64` — stated
 * rather than hidden. `serde_json` would accept a `u64` up to 2^64−1, but
 * `JSON.stringify` cannot emit one above 2^53−1 without losing precision, and a
 * canonical form that silently rounded its own input would defeat the whole
 * point of condition 5. The fields this actually binds are second counts
 * (`min_capture_interval_secs`, `jail_unbond_delay_secs`) where 2^53 seconds is
 * ~285 million years, and a concentration multiple in bps.
 */
export const MAX_JSON_SAFE_UINT = BigInt(Number.MAX_SAFE_INTEGER);

/** bps of 1.0. The contract's own ceiling for every rate-shaped parameter. */
const BPS_MAX = 10_000n;
/** `u32::MAX` — `max_delegations_per_run`'s type ceiling. */
const U32_MAX = 4_294_967_295n;

/**
 * `pause_vault.reason` length cap.
 *
 * A DELIBERATE narrowing: the contract accepts any string, including an empty
 * one, but the reason is rendered to end users as the vault's `pausedReason`,
 * and "paused, no reason given" is the kind of state SECURITY.md's never-lie
 * rule exists to prevent. So this App will neither compose nor relay a
 * pause proposal without one. Declared HERE and imported by the template, the
 * composer form and the guard — one limit, never three literals (§4b C2).
 */
export const MIN_PAUSE_REASON_LEN = 1;
export const MAX_PAUSE_REASON_LEN = 256;

// ── Parameter specs ──────────────────────────────────────────────────────

/**
 * One template parameter, with the bound the CONTRACT enforces.
 *
 * `contractRule` is prose naming where the bound comes from, so a reviewer can
 * trace every number to a check in `contracts/src/state.rs` or a type in
 * `msg.rs` rather than taking it on faith. A parameter whose bound cannot be
 * traced is a stop-and-ask, not a guess (§8).
 */
export type TemplateParam =
  | {
      kind: "uint";
      key: string;
      /** Inclusive. */
      min: bigint;
      /** Inclusive. Never wider than the contract's own check. */
      max: bigint;
      contractRule: string;
      labelKey: MessageKey;
    }
  | { kind: "bool"; key: string; contractRule: string; labelKey: MessageKey }
  | {
      kind: "text";
      key: string;
      minLength: number;
      maxLength: number;
      contractRule: string;
      labelKey: MessageKey;
    };

export interface ProposalTemplate {
  /** The contract execute variant this template composes. */
  id: AdminVariant;
  /**
   * True when every parameter is independently present-or-absent
   * (`update_config` alone: "only supplied fields change"). For every other
   * template the parameter list is exactly required.
   */
  optionalParams: boolean;
  /**
   * Declaration order = canonical JSON key order. `contracts/src/msg.rs`'s
   * field order, so the canonical form is greppable against the source.
   */
  params: readonly TemplateParam[];
  labelKey: MessageKey;
  /** Consequence lines shown before signing (§17.1 confirmation rigor). */
  summaryKeys: readonly MessageKey[];
}

/**
 * The registry. Keyed by admin variant; the order here is the order the picker
 * offers, least destructive first.
 */
export const PROPOSAL_TEMPLATES: readonly ProposalTemplate[] = [
  {
    id: "update_config",
    optionalParams: true,
    // Ten optional fields → 2¹⁰ possible shapes (§4b C1). The canonical builder
    // OMITS absent fields, and condition 5's byte comparison makes the shape
    // space irrelevant to the guard: it never enumerates the 1024 forms, it
    // demands the bytes equal the one form this builder would have produced.
    params: [
      {
        kind: "uint",
        key: "max_delegations_per_run",
        min: 0n,
        max: U32_MAX,
        contractRule: "msg.rs: Option<u32>; Config::validate adds no further bound",
        labelKey: "governance.param-max-delegations-per-run",
      },
      {
        kind: "uint",
        key: "aum_fee_bps",
        min: 0n,
        max: BPS_MAX,
        contractRule: "state.rs Config::validate: aum_fee_bps must be <= 10000",
        labelKey: "governance.param-aum-fee-bps",
      },
      {
        kind: "uint",
        key: "performance_threshold_bps",
        min: 0n,
        max: BPS_MAX,
        contractRule:
          "state.rs Config::validate: performance_threshold_bps must be <= 10000 (0 disables gating)",
        labelKey: "governance.param-performance-threshold-bps",
      },
      {
        kind: "uint",
        key: "min_capture_interval_secs",
        min: 0n,
        max: MAX_JSON_SAFE_UINT,
        contractRule: "msg.rs: Option<u64>; no Config::validate check — bounded here by JSON safety",
        labelKey: "governance.param-min-capture-interval-secs",
      },
      {
        kind: "uint",
        key: "max_concentration_multiple_bps",
        min: 1n,
        max: MAX_JSON_SAFE_UINT,
        contractRule:
          "state.rs Config::validate: max_concentration_multiple_bps must be > 0 (10000 = 1x)",
        labelKey: "governance.param-max-concentration-multiple-bps",
      },
      {
        kind: "uint",
        key: "min_bonded_cap_bps",
        // The contract's rule is CROSS-FIELD (min <= max) against the MERGED
        // config, so it cannot be a per-field bound — an unsupplied
        // `max_bonded_cap_bps` keeps the stored one. Preflight restates it
        // against the live `Config {}` read; here the field carries only the
        // bound implied by max_bonded_cap_bps's own 1..=10000 ceiling.
        min: 0n,
        max: BPS_MAX,
        contractRule:
          "state.rs Config::validate: min_bonded_cap_bps must be <= max_bonded_cap_bps (CROSS-FIELD against the MERGED config, so it is not a per-field bound; restated in runGovernancePreflight, which is the one place with a live Config {} read)",
        labelKey: "governance.param-min-bonded-cap-bps",
      },
      {
        kind: "uint",
        key: "max_bonded_cap_bps",
        min: 1n,
        max: BPS_MAX,
        contractRule: "state.rs Config::validate: max_bonded_cap_bps must be in 1..=10000",
        labelKey: "governance.param-max-bonded-cap-bps",
      },
      {
        kind: "uint",
        key: "concentration_safety_offset_bps",
        min: 0n,
        // Strictly below 10000: the contract rejects 10000 explicitly, because
        // a 100% offset would silently zero every deploy target.
        max: BPS_MAX - 1n,
        contractRule:
          "state.rs Config::validate: concentration_safety_offset_bps must be < 10000",
        labelKey: "governance.param-concentration-safety-offset-bps",
      },
      {
        kind: "uint",
        key: "commission_bps",
        min: 0n,
        max: BPS_MAX,
        contractRule: "state.rs Config::validate: commission_bps must be <= 10000",
        labelKey: "governance.param-commission-bps",
      },
      {
        kind: "uint",
        key: "jail_unbond_delay_secs",
        min: 0n,
        max: MAX_JSON_SAFE_UINT,
        contractRule: "msg.rs: Option<u64>; no Config::validate check — bounded here by JSON safety",
        labelKey: "governance.param-jail-unbond-delay-secs",
      },
    ],
    labelKey: "governance.template-update-config",
    summaryKeys: [
      "governance.confirm-update-config-1",
      "governance.confirm-update-config-2",
    ],
  },
  {
    id: "set_halted",
    optionalParams: false,
    params: [
      {
        kind: "bool",
        key: "halted",
        contractRule: "msg.rs SetHalted { halted: bool }",
        labelKey: "governance.param-halted",
      },
    ],
    labelKey: "governance.template-set-halted",
    summaryKeys: ["governance.confirm-set-halted-1", "governance.confirm-set-halted-2"],
  },
  {
    id: "pause_vault",
    optionalParams: false,
    params: [
      {
        kind: "text",
        key: "reason",
        minLength: MIN_PAUSE_REASON_LEN,
        maxLength: MAX_PAUSE_REASON_LEN,
        contractRule:
          "msg.rs PauseVault { reason: String }; the length floor/ceiling is this App's (see MAX_PAUSE_REASON_LEN)",
        labelKey: "governance.param-pause-reason",
      },
    ],
    labelKey: "governance.template-pause-vault",
    summaryKeys: ["governance.confirm-pause-vault-1", "governance.confirm-pause-vault-2"],
  },
  {
    id: "unpause_vault",
    optionalParams: false,
    params: [],
    labelKey: "governance.template-unpause-vault",
    summaryKeys: ["governance.confirm-unpause-vault-1"],
  },
  {
    id: "clear_pending_delegations",
    optionalParams: false,
    params: [],
    labelKey: "governance.template-clear-pending-delegations",
    summaryKeys: [
      "governance.confirm-clear-pending-1",
      "governance.confirm-clear-pending-2",
    ],
  },
] as const;

/** Lookup by variant. Built once; the guard runs on every relayed proposal. */
const BY_ID = new Map<string, ProposalTemplate>(PROPOSAL_TEMPLATES.map((tpl) => [tpl.id, tpl]));

export function templateById(id: string): ProposalTemplate | null {
  return BY_ID.get(id) ?? null;
}

// ── Values ───────────────────────────────────────────────────────────────

/** A parameter value, in the JS type its `kind` implies. */
export type TemplateValue = bigint | boolean | string;
/** A template instance's parameters. Absent key = not supplied. */
export type TemplateValues = Readonly<Record<string, TemplateValue>>;

/** Why a supplied value is not acceptable. Machine-readable; localized by the
 * composer, and used verbatim as a guard rejection reason server-side. */
export type TemplateParamError =
  | { code: "unknown-template"; id: string }
  | { code: "unknown-param"; key: string }
  | { code: "missing-param"; key: string }
  | { code: "wrong-type"; key: string }
  | { code: "out-of-range"; key: string; min: string; max: string }
  | { code: "length-out-of-range"; key: string; min: number; max: number }
  | { code: "no-fields-supplied" };

/**
 * Validate values against a template's declared bounds.
 *
 * REJECT, NEVER CLAMP (the repo-standard numeric rule, the same subject
 * `test/amount.test.ts` pins). A value outside a contract bound is a shape
 * error the user must fix, not one this module quietly moves inside the range —
 * a clamped bps would submit a governance proposal for a number nobody chose.
 */
export function validateTemplateValues(
  id: string,
  values: TemplateValues,
): TemplateParamError[] {
  const template = templateById(id);
  if (template === null) return [{ code: "unknown-template", id }];

  const errors: TemplateParamError[] = [];
  const declared = new Map(template.params.map((p) => [p.key, p] as const));
  for (const key of Object.keys(values)) {
    if (!declared.has(key)) errors.push({ code: "unknown-param", key });
  }

  for (const param of template.params) {
    const supplied = Object.prototype.hasOwnProperty.call(values, param.key);
    if (!supplied) {
      if (!template.optionalParams) errors.push({ code: "missing-param", key: param.key });
      continue;
    }
    const value = values[param.key]!;
    switch (param.kind) {
      case "uint": {
        if (typeof value !== "bigint") {
          errors.push({ code: "wrong-type", key: param.key });
          break;
        }
        if (value < param.min || value > param.max) {
          errors.push({
            code: "out-of-range",
            key: param.key,
            min: param.min.toString(),
            max: param.max.toString(),
          });
        }
        break;
      }
      case "bool": {
        if (typeof value !== "boolean") errors.push({ code: "wrong-type", key: param.key });
        break;
      }
      case "text": {
        if (typeof value !== "string") {
          errors.push({ code: "wrong-type", key: param.key });
          break;
        }
        if (value.length < param.minLength || value.length > param.maxLength) {
          errors.push({
            code: "length-out-of-range",
            key: param.key,
            min: param.minLength,
            max: param.maxLength,
          });
        }
        break;
      }
    }
  }

  // `update_config` with nothing supplied is a no-op proposal: it would pass the
  // contract (every field is optional) and change nothing, so it is a governance
  // vote on nothing. Refused at the boundary rather than composed.
  if (template.optionalParams && Object.keys(values).length === 0) {
    errors.push({ code: "no-fields-supplied" });
  }
  return errors;
}

/**
 * The CANONICAL inner execute payload for a template instance — the ONE place
 * this JSON is produced, exactly as `operatorInnerJson` is for M6.4.
 *
 * Both the composer and the relay guard call it: the guard re-encodes what it
 * parsed and requires byte equality, so the only inner payload the relay will
 * carry is one this function would have produced. Key reordering, duplicate
 * keys, whitespace padding, unicode-escaped variant names and an appended
 * second object all fail that comparison without this module having to detect
 * any of them — which is what keeps the guard out of a parser arms race.
 *
 * Throws on values this module refuses to serialize. Callers validate first;
 * the throw is the backstop that keeps the invariant true however the values
 * were constructed (the `encodeExecuteContract` precedent).
 */
export function templateInnerJson(id: string, values: TemplateValues): string {
  const errors = validateTemplateValues(id, values);
  if (errors.length > 0) {
    throw new Error(`not a template instance: ${errors.map((e) => e.code).join(", ")}`);
  }
  const template = templateById(id)!;
  const body: Record<string, number | boolean | string> = {};
  // Declaration order, absent fields OMITTED. `cargo schema` confirms every
  // `update_config` field is optional (none appears in its `required` list), so
  // omission is the shape the contract reads as "do not change this".
  for (const param of template.params) {
    if (!Object.prototype.hasOwnProperty.call(values, param.key)) continue;
    const value = values[param.key]!;
    body[param.key] =
      param.kind === "uint" ? Number(value as bigint) : (value as boolean | string);
  }
  return JSON.stringify({ [template.id]: body });
}

/**
 * Parse template values as they cross the CLIENT → SERVER boundary.
 *
 * `bigint` does not survive JSON, so a uint parameter travels as a canonical
 * DECIMAL STRING — the same convention `preflightRequestSchema` already uses
 * for amounts, and for the same reason: a number would silently lose precision
 * above 2^53 and a float would look like a rounding opportunity rather than a
 * shape error. Non-canonical spellings (`"007"`, `"1e3"`, `" 12"`) are REJECTED
 * rather than normalized, so one value has one spelling all the way down.
 *
 * Lives here rather than in the route schema because the boundary must not be a
 * second place that decides what a template's parameters are (invariant 6).
 */
export type WireTemplateValues = Readonly<Record<string, string | boolean>>;

const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;

export function parseTemplateValues(
  id: string,
  raw: WireTemplateValues,
): { ok: true; values: TemplateValues } | { ok: false; errors: TemplateParamError[] } {
  const template = templateById(id);
  if (template === null) return { ok: false, errors: [{ code: "unknown-template", id }] };
  const declared = new Map(template.params.map((p) => [p.key, p] as const));
  const values: Record<string, TemplateValue> = {};
  const errors: TemplateParamError[] = [];

  for (const [key, value] of Object.entries(raw)) {
    const param = declared.get(key);
    if (param === undefined) {
      errors.push({ code: "unknown-param", key });
      continue;
    }
    if (param.kind === "uint") {
      if (typeof value !== "string" || !CANONICAL_UINT.test(value) || value.length > 39) {
        errors.push({ code: "wrong-type", key });
        continue;
      }
      values[key] = BigInt(value);
    } else if (param.kind === "bool") {
      if (typeof value !== "boolean") {
        errors.push({ code: "wrong-type", key });
        continue;
      }
      values[key] = value;
    } else {
      if (typeof value !== "string") {
        errors.push({ code: "wrong-type", key });
        continue;
      }
      values[key] = value;
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const bounds = validateTemplateValues(id, values);
  return bounds.length > 0 ? { ok: false, errors: bounds } : { ok: true, values };
}

/**
 * The form's starting values for a template.
 *
 * REQUIRED parameters are seeded; optional ones (`update_config`'s ten) are
 * NOT, because for them "absent" is the meaningful default — a seeded key would
 * silently put a field into a proposal the proposer never chose to change.
 *
 * A seeded `bool` matters more than it looks: without it, choosing `halted:
 * false` would take TWO clicks (on, then off) because only a change event adds
 * the key, and the form would sit in a `missing-param` error meanwhile.
 */
export function defaultWireValues(id: string): WireTemplateValues {
  const template = templateById(id);
  if (template === null || template.optionalParams) return {};
  const values: Record<string, string | boolean> = {};
  for (const param of template.params) {
    values[param.key] = param.kind === "bool" ? false : "";
  }
  return values;
}

/** Values back out to the wire shape (the composer form's own state). */
export function toWireTemplateValues(values: TemplateValues): WireTemplateValues {
  const out: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = typeof value === "bigint" ? value.toString() : value;
  }
  return out;
}

/** A one-line, non-localized rendering of a parameter error, for the
 * `template-invalid` preflight reason's `detail`. */
export function describeTemplateError(error: TemplateParamError): string {
  switch (error.code) {
    case "unknown-template":
      return `unknown action "${error.id}"`;
    case "unknown-param":
      return `"${error.key}" is not a field of this action`;
    case "missing-param":
      return `"${error.key}" is required`;
    case "wrong-type":
      return `"${error.key}" is not the expected type`;
    case "out-of-range":
      return `"${error.key}" must be between ${error.min} and ${error.max}`;
    case "length-out-of-range":
      return `"${error.key}" must be between ${error.min} and ${error.max} characters`;
    case "no-fields-supplied":
      return "no setting was selected to change";
  }
}

// ── Presentation helpers (pure; the composer and the confirm step share them) ──

/**
 * Every template id, in picker order.
 *
 * Typed as `AdminVariant[]`, so a template for a variant `contracts/src/msg.rs`
 * does not define is a TYPE error here. The other direction — an admin variant
 * with NO template, which would make a new admin capability quietly unreachable
 * — cannot be caught by a type, and is the gate in
 * `test/governance-templates.test.ts` (invariant 7's disproof line).
 */
export const TEMPLATE_IDS: readonly AdminVariant[] = PROPOSAL_TEMPLATES.map((tpl) => tpl.id);

/**
 * One `key: value` line per SUPPLIED parameter, for the confirm step and the
 * diff view. Values are display strings; nothing is invented for an absent one.
 */
export function templateFieldLines(
  id: string,
  values: TemplateValues,
): { key: string; labelKey: MessageKey; value: string }[] {
  const template = templateById(id);
  if (template === null) return [];
  return template.params
    .filter((param) => Object.prototype.hasOwnProperty.call(values, param.key))
    .map((param) => ({
      key: param.key,
      labelKey: param.labelKey,
      value: String(values[param.key]),
    }));
}

/**
 * The `update_config` DIFF (§8.7's named requirement, D19): current → proposed
 * for exactly the fields being changed, with untouched fields visibly untouched.
 *
 * `current` is the live `Config {}` read, keyed by the same parameter names.
 * A field whose current value could not be read renders `null` on that side —
 * never `0`, which would assert a value the read never produced.
 *
 * `unchanged` is the third state §2.3 requires the composer to distinguish:
 * "not supplied" and "supplied as the current value" are different messages on
 * the wire (one omits the key, one sets it to the same number) even though the
 * contract's merge makes them equivalent, and the user is told which they built.
 */
export interface ConfigDiffRow {
  key: string;
  labelKey: MessageKey;
  current: string | null;
  proposed: string | null;
  state: "changed" | "unchanged" | "untouched";
}

export function configDiffRows(
  values: TemplateValues,
  current: Readonly<Record<string, bigint | null>>,
): ConfigDiffRow[] {
  const template = templateById("update_config")!;
  return template.params.map((param) => {
    const supplied = Object.prototype.hasOwnProperty.call(values, param.key);
    const currentValue = current[param.key] ?? null;
    const proposed = supplied ? String(values[param.key]) : null;
    const state: ConfigDiffRow["state"] = !supplied
      ? "untouched"
      : currentValue !== null && proposed === currentValue.toString()
        ? "unchanged"
        : "changed";
    return {
      key: param.key,
      labelKey: param.labelKey,
      current: currentValue === null ? null : currentValue.toString(),
      proposed,
      state,
    };
  });
}

/**
 * The i18n key (and its placeholders) that summarizes a template instance.
 *
 * Returns a KEY rather than a translated string so this module stays free of
 * runtime i18n imports (see the import note at the top). The keys are the SAME
 * ones `app/governance/decode.ts` resolves for a proposal it reads back, which
 * is what makes invariant 6 — compose and decode agree — a property of one
 * vocabulary rather than of two tables that happen to match.
 */
export function templateSummaryKey(
  id: string,
  values: TemplateValues,
): { key: MessageKey; params: Record<string, string> } {
  const template = templateById(id);
  if (template === null) return { key: "governance.msg-unknown-variant", params: {} };
  if (id === "set_halted") {
    const halted = values["halted"];
    if (typeof halted !== "boolean") return { key: "governance.msg-set-halted-unknown", params: {} };
    return {
      key: halted ? "governance.msg-set-halted-on" : "governance.msg-set-halted-off",
      params: {},
    };
  }
  if (id === "update_config") {
    // NAMING the supplied fields is a fact about the message; what each new
    // value means for the program is the diff view above (D19).
    const fields = Object.keys(values).join(", ");
    return fields === ""
      ? { key: "governance.msg-update-config-generic", params: {} }
      : { key: "governance.msg-update-config", params: { fields } };
  }
  // These three carry no placeholder — passing one would be noise, and the
  // i18n placeholder gate checks the pairing in both directions.
  if (id === "pause_vault") return { key: "governance.msg-pause-vault", params: {} };
  if (id === "unpause_vault") return { key: "governance.msg-unpause-vault", params: {} };
  return { key: "governance.msg-clear-pending-delegations", params: {} };
}
