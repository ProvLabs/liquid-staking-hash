// Alert evaluation core (app-spec §8.2, §10.4; /§2.4) — PURE,
// shared by the notifier worker and the settings/bell surfaces (Commit C).
// No Prisma, no fetch, no clock: facts + effective settings + presence in,
// candidate notifications out. Every branch is unit-testable without Postgres
// or a network (test/notifier.test.ts, test/notification-payload.test.ts).
//
// Two structural rules this module encodes:
//   * absence-means-default (§2.1): no rule row = the kind's default (ON for
//     the R2 set, OFF for the rest); a row is only ever an explicit override.
//   * payload minimalism (§2.1): each kind's payload is a CLOSED (`.strict()`)
//     zod shape of identifiers/ordinals only — never an amount. A stored amount
//     goes stale and violates §12.1, and this keeps the 6.3 push payload a
//     strict subset of an already-minimal shape.

import type {
  AlertArrearsFact,
  AlertIncidentFact,
  AlertRedemptionFact,
  IncidentKind,
} from "@nvhash/api-types";
import { z } from "zod";

// ── The closed alert-kind set (mirrors prisma/alert_rules.prisma AlertKind) ──

export const ALERT_KINDS = [
  "nav_step_posted",
  "redemption_update",
  "vault_status",
  "validator_set_incident",
  "operator_arrears",
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

/** The R2 default-on set (§14.7, Ira 2026-07-24): everything else is opt-in. */
export const DEFAULT_ON: ReadonlySet<AlertKind> = new Set<AlertKind>([
  "redemption_update",
  "operator_arrears",
]);

/** Kinds shown only to operator sessions (UI convenience; §8.6). */
export const OPERATOR_KINDS: ReadonlySet<AlertKind> = new Set<AlertKind>(["operator_arrears"]);

/** Bound a client-supplied kind to the closed set (settings POST, §2.6). */
export const alertKindSchema = z.enum(ALERT_KINDS);

// ── Effective-settings merge (the one place default × override resolves) ─────

/** One row of the effective settings view (closed kind list × override × default). */
export interface EffectiveSetting {
  kind: AlertKind;
  enabled: boolean;
  /** true when this kind is on-by-default (rendered "on by default", §8.2). */
  isDefault: boolean;
}

/**
 * Is `kind` effectively enabled for an address, given its override rows
 * (kind → enabled)? Absence = the kind's default. The single source of truth
 * for both the notifier's suppression and the settings UI's toggle state.
 */
export function isKindEnabled(
  kind: AlertKind,
  overrides: ReadonlyMap<AlertKind, boolean>,
): boolean {
  const override = overrides.get(kind);
  return override === undefined ? DEFAULT_ON.has(kind) : override;
}

/** The full effective-settings view over the closed kind list. */
export function effectiveSettings(overrides: ReadonlyMap<AlertKind, boolean>): EffectiveSetting[] {
  return ALERT_KINDS.map((kind) => ({
    kind,
    enabled: isKindEnabled(kind, overrides),
    isDefault: DEFAULT_ON.has(kind),
  }));
}

// ── Closed per-kind payload shapes (identifiers/ordinals only, no amounts) ───

const epochIndex = z.number().int().nonnegative();

export const navStepPayloadSchema = z.object({ epoch_index: epochIndex }).strict();
export const redemptionPayloadSchema = z
  .object({
    request_id: z.string().min(1).max(128),
    event: z.enum(["matured", "expedited", "refunded"]),
  })
  .strict();
export const incidentPayloadSchema = z
  .object({
    incident_kind: z.enum([
      "contract_halted",
      "vault_paused",
      "slash_write_down",
      "redemption_refund",
      "jail_report",
      "epoch_overdue",
      "reconciler_divergence",
      "indexer_lag",
    ]),
  })
  .strict();
export const arrearsPayloadSchema = z
  .object({ valoper: z.string().min(1).max(90), epoch_index: epochIndex })
  .strict();

/** The closed payload schema for each alert kind (keys the payload gate). */
export const PAYLOAD_SCHEMAS: Record<AlertKind, z.ZodType> = {
  nav_step_posted: navStepPayloadSchema,
  redemption_update: redemptionPayloadSchema,
  vault_status: incidentPayloadSchema,
  validator_set_incident: incidentPayloadSchema,
  operator_arrears: arrearsPayloadSchema,
};

/** Validate a payload against its kind's closed shape (defense at insert). */
export function parsePayload(kind: AlertKind, payload: unknown): unknown {
  return PAYLOAD_SCHEMAS[kind].parse(payload);
}

// ── Web Push payload subsetting (invariant 3) ─────────────────
//
// The push body is the CLOSED `{ kind, url }` shape — a strict subset of the
// already-minimal stored payload: NO amounts, NO addresses, NO request ids, NO
// identifiers beyond the kind. It is derived from the KIND ALONE (never the
// stored payload's fields), so it is structurally impossible for a request id,
// valoper, or epoch index to leak to the third-party push service. Title/body
// are rendered generically by the service worker from the kind; the deep link
// is the generic per-kind surface (the bell's §2.6 mapping — kept in lockstep
// with `linkFor` in components/chrome/alerts-bell.tsx; the client bell can't
// import this .server module, so the mapping is mirrored, not shared).

/** Generic per-kind deep link — mirrors alerts-bell.tsx `linkFor` (§2.6). */
export const PUSH_DEEP_LINK: Record<AlertKind, string> = {
  redemption_update: "/exit",
  operator_arrears: "/validators",
  validator_set_incident: "/validators",
  nav_step_posted: "/portfolio",
  vault_status: "/portfolio",
};

/** The closed push payload shape — the gate rejects any extra key (§2.3). */
export const pushPayloadSchema = z
  .object({
    // App-relative only: one leading "/" and the second char must not be "/",
    // so a protocol-relative "//host" (even a dot-less one) can never pass.
    kind: alertKindSchema,
    url: z.string().regex(/^\/(?:[A-Za-z0-9_-][A-Za-z0-9/_-]*)?$/, "expected an app-relative path"),
  })
  .strict();
export type PushPayload = z.infer<typeof pushPayloadSchema>;

/**
 * The `{ kind, url }` push body for a notification, derived from its KIND alone
 * — never its stored payload. Taking only `kind` is the mechanism that makes
 * invariant 3 structural: no amount/address/id field exists to carry over.
 */
export function toPushPayload(kind: AlertKind): PushPayload {
  return pushPayloadSchema.parse({ kind, url: PUSH_DEEP_LINK[kind] });
}

// ── Incident → alert-kind mapping (closed; ops-facing kinds excluded) ────────
//
// (§2.4) vault_status ← {vault_paused, contract_halted};
//        validator_set_incident ← {jail_report, slash_write_down}.
// reconciler_divergence / indexer_lag / epoch_overdue / redemption_refund are
// excluded (ops-facing, or covered per-owner by redemption_update). No
// close/"resumed" notifications in v1 (§7 Q3).
export const INCIDENT_ALERT_KIND: Partial<Record<IncidentKind, AlertKind>> = {
  vault_paused: "vault_status",
  contract_halted: "vault_status",
  jail_report: "validator_set_incident",
  slash_write_down: "validator_set_incident",
};

// ── Candidates: what evaluation produces (facts × settings × presence) ───────

export interface Candidate {
  address: string;
  kind: AlertKind;
  /** Replay-stable identity (§2.4) — the notifications unique key. */
  dedupeKey: string;
  /** Closed per-kind payload (already validated by its schema). */
  payload: unknown;
}

/** Terminal redemption legs, in a fixed order so output is deterministic. */
const REDEMPTION_EVENTS = [
  { event: "expedited", at: (f: AlertRedemptionFact) => f.expedited_at },
  { event: "matured", at: (f: AlertRedemptionFact) => f.matured_at },
  { event: "refunded", at: (f: AlertRedemptionFact) => f.refunded_at },
] as const;

/**
 * `redemption_update` (default-ON): for each terminal transition (each non-null
 * of expedited/matured/refunded), notify `owner` iff owner is present AND has
 * not opted out. A request that matures then refunds produces two
 * notifications — distinct dedupe keys `req:<id>:<event>` (§2.4).
 */
export function evaluateRedemptions(
  facts: readonly AlertRedemptionFact[],
  present: ReadonlySet<string>,
  optedOut: ReadonlySet<string>,
): Candidate[] {
  const out: Candidate[] = [];
  for (const fact of facts) {
    if (!present.has(fact.owner) || optedOut.has(fact.owner)) continue;
    for (const leg of REDEMPTION_EVENTS) {
      if (leg.at(fact) === null) continue;
      out.push({
        address: fact.owner,
        kind: "redemption_update",
        dedupeKey: `req:${fact.request_id}:${leg.event}`,
        payload: redemptionPayloadSchema.parse({ request_id: fact.request_id, event: leg.event }),
      });
    }
  }
  return out;
}

/**
 * `operator_arrears` (default-ON): notify each arrears fact's `operator` iff
 * present AND not opted out. dedupeKey `arrears:<valoper>:<epoch_index>` — one
 * alert per validator per epoch in arrears (§2.4).
 */
export function evaluateArrears(
  facts: readonly AlertArrearsFact[],
  present: ReadonlySet<string>,
  optedOut: ReadonlySet<string>,
): Candidate[] {
  const out: Candidate[] = [];
  for (const fact of facts) {
    if (!present.has(fact.operator) || optedOut.has(fact.operator)) continue;
    out.push({
      address: fact.operator,
      kind: "operator_arrears",
      dedupeKey: `arrears:${fact.valoper}:${fact.epoch_index}`,
      payload: arrearsPayloadSchema.parse({ valoper: fact.valoper, epoch_index: fact.epoch_index }),
    });
  }
  return out;
}

/**
 * `vault_status` / `validator_set_incident` (default-OFF): a mapped incident
 * fans out to the addresses that opted IN to its alert kind. dedupeKey
 * `incident:<incident_kind>:<dedupe_key>` — the indexer's own
 * `(kind, dedupeKey)` pair, replay-stable across drop-and-rebuild (§2.4).
 * Unmapped (ops-facing) incidents produce nothing.
 */
export function evaluateIncidents(
  facts: readonly AlertIncidentFact[],
  optInsForKind: (kind: AlertKind) => ReadonlySet<string>,
): Candidate[] {
  const out: Candidate[] = [];
  for (const fact of facts) {
    const alertKind = INCIDENT_ALERT_KIND[fact.kind];
    if (alertKind === undefined) continue;
    const payload = incidentPayloadSchema.parse({ incident_kind: fact.kind });
    const dedupeKey = `incident:${fact.kind}:${fact.dedupe_key}`;
    for (const address of optInsForKind(alertKind)) {
      out.push({ address, kind: alertKind, dedupeKey, payload });
    }
  }
  return out;
}

/**
 * `nav_step_posted` (default-OFF): each newly-settled epoch fans out to the
 * addresses that opted IN. dedupeKey `epoch:<epoch_index>` — a chain-canonical
 * ordinal (§2.4).
 */
export function evaluateNavSteps(
  epochIndexes: readonly number[],
  optIns: ReadonlySet<string>,
): Candidate[] {
  const out: Candidate[] = [];
  for (const index of epochIndexes) {
    const payload = navStepPayloadSchema.parse({ epoch_index: index });
    for (const address of optIns) {
      out.push({ address, kind: "nav_step_posted", dedupeKey: `epoch:${index}`, payload });
    }
  }
  return out;
}
