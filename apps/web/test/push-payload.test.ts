// Push payload gate (plan 6.3 §3 commit B, §4.3 — new, standing). The push
// body is the CLOSED `{ kind, url }` shape and a strict subset of the stored
// notification payload's information: NO amounts, NO addresses, NO request ids,
// nothing beyond the kind. Because `toPushPayload` takes only a KIND (never a
// stored payload), it is structurally impossible for an identifier to leak to
// the third-party push service — this gate pins that.

import { describe, expect, it } from "vitest";

import {
  ALERT_KINDS,
  PUSH_DEEP_LINK,
  pushPayloadSchema,
  redemptionPayloadSchema,
  toPushPayload,
} from "~/lib/services/alerts.server";

describe("push payload is the closed { kind, url } shape", () => {
  it("every alert kind yields exactly { kind, url } with an app-relative url", () => {
    for (const kind of ALERT_KINDS) {
      const payload = toPushPayload(kind);
      expect(Object.keys(payload).sort()).toEqual(["kind", "url"]);
      expect(payload.kind).toBe(kind);
      expect(payload.url).toMatch(/^\//); // app-relative, never external
    }
  });

  it("the deep-link map covers every kind and only app-relative paths", () => {
    for (const kind of ALERT_KINDS) {
      expect(PUSH_DEEP_LINK[kind], kind).toMatch(/^\/[A-Za-z0-9/_-]*$/);
    }
  });
});

describe("the schema rejects anything but { kind, url } (invariant 3)", () => {
  it("rejects amount-, address-, and id-bearing keys", () => {
    expect(pushPayloadSchema.safeParse({ kind: "redemption_update", url: "/exit", request_id: "r1" }).success).toBe(false);
    expect(pushPayloadSchema.safeParse({ kind: "redemption_update", url: "/exit", amount_nhash: "5" }).success).toBe(false);
    expect(pushPayloadSchema.safeParse({ kind: "redemption_update", url: "/exit", shares: "5" }).success).toBe(false);
    expect(pushPayloadSchema.safeParse({ kind: "operator_arrears", url: "/validators", valoper: "pbvaloper1" }).success).toBe(false);
    expect(pushPayloadSchema.safeParse({ kind: "nav_step_posted", url: "/portfolio", address: "tp1xyz" }).success).toBe(false);
  });

  it("rejects an unknown kind and a non-app-relative url", () => {
    expect(pushPayloadSchema.safeParse({ kind: "not_a_kind", url: "/exit" }).success).toBe(false);
    expect(pushPayloadSchema.safeParse({ kind: "vault_status", url: "https://evil.example" }).success).toBe(false);
    expect(pushPayloadSchema.safeParse({ kind: "vault_status", url: "//evil.example" }).success).toBe(false);
    // Protocol-relative WITHOUT a dot: must still fail (the leading "//" alone
    // is disqualifying — the regex can't rely on the host containing a ".").
    expect(pushPayloadSchema.safeParse({ kind: "vault_status", url: "//evilexample" }).success).toBe(false);
  });
});

describe("the push body reveals strictly LESS than the stored payload", () => {
  it("carries no key that the stored redemption payload carries (subset of information)", () => {
    // A stored redemption payload identifies the request + which leg.
    const stored = redemptionPayloadSchema.parse({ request_id: "req-42", event: "matured" });
    const push = toPushPayload("redemption_update");
    for (const key of Object.keys(stored)) {
      expect(Object.keys(push)).not.toContain(key); // request_id / event never cross
    }
    // And the request id string appears nowhere in the serialized push body.
    expect(JSON.stringify(push)).not.toContain("req-42");
  });
});
