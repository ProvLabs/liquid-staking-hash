// Payload minimalism gate (standing): stored notification
// payloads are CLOSED shapes of identifiers/ordinals only — NEVER amounts. A
// stored amount goes stale and violates §12.1, and this keeps the 6.3 push
// payload a strict subset of an already-minimal shape. Each kind's schema
// rejects extra keys (`.strict()`) and, specifically, any amount-shaped key.

import { describe, expect, it } from "vitest";
import {
  ALERT_KINDS,
  PAYLOAD_SCHEMAS,
  arrearsPayloadSchema,
  incidentPayloadSchema,
  navStepPayloadSchema,
  redemptionPayloadSchema,
  type AlertKind,
} from "~/lib/services/alerts.server";

/** The exact key set each kind's payload may carry — nothing else. */
const EXPECTED_KEYS: Record<AlertKind, string[]> = {
  nav_step_posted: ["epoch_index"],
  redemption_update: ["request_id", "event"],
  vault_status: ["incident_kind"],
  validator_set_incident: ["incident_kind"],
  operator_arrears: ["valoper", "epoch_index"],
};

const VALID: Record<AlertKind, unknown> = {
  nav_step_posted: { epoch_index: 12 },
  redemption_update: { request_id: "req-1", event: "matured" },
  vault_status: { incident_kind: "vault_paused" },
  validator_set_incident: { incident_kind: "jail_report" },
  operator_arrears: { valoper: "pbvaloper1aaa", epoch_index: 12 },
};

/** Amount-shaped keys that must NEVER be accepted on any payload. */
const AMOUNT_KEYS = ["amount", "shares", "nhash", "commission_due", "value_nhash", "hash_amount"];

describe("notification payload shapes (closed, identifier-only)", () => {
  it("covers every alert kind with a schema and an expected key set", () => {
    for (const kind of ALERT_KINDS) {
      expect(PAYLOAD_SCHEMAS[kind], kind).toBeDefined();
      expect(EXPECTED_KEYS[kind], kind).toBeDefined();
    }
  });

  it("accepts exactly its key set and nothing more (each kind)", () => {
    for (const kind of ALERT_KINDS) {
      const parsed = PAYLOAD_SCHEMAS[kind].parse(VALID[kind]) as Record<string, unknown>;
      expect(Object.keys(parsed).sort(), kind).toEqual([...EXPECTED_KEYS[kind]].sort());
    }
  });

  it("rejects any extra key (strict shapes)", () => {
    for (const kind of ALERT_KINDS) {
      const withExtra = { ...(VALID[kind] as object), surprise: 1 };
      expect(PAYLOAD_SCHEMAS[kind].safeParse(withExtra).success, kind).toBe(false);
    }
  });

  it("rejects every amount-shaped key on every kind (no amounts, ever)", () => {
    for (const kind of ALERT_KINDS) {
      for (const amountKey of AMOUNT_KEYS) {
        const tainted = { ...(VALID[kind] as object), [amountKey]: "1000" };
        expect(
          PAYLOAD_SCHEMAS[kind].safeParse(tainted).success,
          `${kind} must reject ${amountKey}`,
        ).toBe(false);
      }
    }
  });

  it("rejects malformed leaf values (bounds at the boundary)", () => {
    expect(navStepPayloadSchema.safeParse({ epoch_index: -1 }).success).toBe(false);
    expect(redemptionPayloadSchema.safeParse({ request_id: "r", event: "queued" }).success).toBe(
      false,
    );
    expect(incidentPayloadSchema.safeParse({ incident_kind: "not_a_kind" }).success).toBe(false);
    expect(arrearsPayloadSchema.safeParse({ valoper: "v", epoch_index: 1.5 }).success).toBe(false);
  });
});
