// The incident-acknowledgment gate (plan invariants 10 and 11, and §4b C1/C3).
//
//  10 — THE WEB TIER NEVER WRITES `incidents`. The store's whole surface is
//       `app.incident_acks`; the grant boundary is the mechanism
//       (`app_writer` holds no `indexed` grants) and is gated by the standing
//       services/indexer integration test. What is asserted HERE is the half
//       this tier owns: the store touches one model and no other.
//  11 — ACKNOWLEDGMENT IS BOUND TO THE SESSION ADDRESS, never a
//       client-supplied actor, and reversal preserves history rather than
//       deleting it.
//  C1/C3 — the "one LIVE ack per (incident, admin)" rule is a CONSTRAINT, so a
//       duplicate is refused rather than silently overwriting, and two admins
//       can both hold an ack on the same incident.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  AckConflict,
  InMemoryIncidentAckStore,
  MAX_ACK_NOTE_LENGTH,
  type IncidentAckStore,
} from "~/lib/models/incident-acks.server";
import { ackBodySchema } from "~/admin/ack.server";

const ADMIN_A = "tp1l39wu7cht0zcycc5rkcd90sdd4ksjmxwdf388y";
const ADMIN_B = "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad";
const T0 = new Date("2026-07-31T00:00:00.000Z");
const T1 = new Date("2026-07-31T01:00:00.000Z");

function store(): IncidentAckStore {
  return new InMemoryIncidentAckStore();
}

describe("the live-ack constraint (C1/C3), not an application pre-check", () => {
  it("refuses a SECOND live ack by the same admin with AckConflict", async () => {
    const s = store();
    await s.acknowledge(7, ADMIN_A, null, T0);
    // `incidentId` alone as a key would have silently overwritten here. The
    // conflict is the correct answer and the caller renders 409.
    await expect(s.acknowledge(7, ADMIN_A, null, T1)).rejects.toBeInstanceOf(AckConflict);
  });

  it("admits a SECOND admin's ack of the same incident", async () => {
    // The multiplicity §4b C1 identified: N > 1 acks per incident. A composite
    // key on `incidentId` alone would have lost one of these.
    const s = store();
    await s.acknowledge(7, ADMIN_A, "known upstream outage", T0);
    await s.acknowledge(7, ADMIN_B, null, T1);
    const live = await s.liveAcksFor([7]);
    // The map is keyed by incident, so it surfaces ONE of them — but both rows
    // exist, which is what the reversal below proves.
    expect(live.has(7)).toBe(true);
    await s.unacknowledge(7, ADMIN_A, T1);
    const after = await s.liveAcksFor([7]);
    expect(after.get(7)?.acknowledgedBy).toBe(ADMIN_B);
  });

  it("re-acknowledging is allowed AFTER a reversal", async () => {
    // The other multiplicity: N > 1 over time. The partial index frees the pair
    // once `unacknowledgedAt` is stamped.
    const s = store();
    await s.acknowledge(7, ADMIN_A, null, T0);
    await s.unacknowledge(7, ADMIN_A, T0);
    await expect(s.acknowledge(7, ADMIN_A, "back again", T1)).resolves.toMatchObject({
      acknowledgedBy: ADMIN_A,
      unacknowledgedAt: null,
    });
  });
});

describe("reversal preserves history rather than deleting it (invariant 11)", () => {
  it("stamps unacknowledgedAt and keeps the row", async () => {
    const s = store();
    const created = await s.acknowledge(7, ADMIN_A, "acked", T0);
    const reversed = await s.unacknowledge(7, ADMIN_A, T1);
    expect(reversed?.id).toBe(created.id); // the SAME row, not a replacement
    expect(reversed?.unacknowledgedAt).toEqual(T1);
    expect(reversed?.note).toBe("acked"); // the note survives the reversal
    // It is no longer live, so the feed shows the incident as unacknowledged.
    expect((await s.liveAcksFor([7])).has(7)).toBe(false);
  });

  it("never reverses ANOTHER admin's acknowledgment", async () => {
    const s = store();
    await s.acknowledge(7, ADMIN_A, null, T0);
    // B has no live ack of 7, so B's reversal finds nothing — it does not reach
    // A's row, because `acknowledgedBy` is part of the predicate.
    expect(await s.unacknowledge(7, ADMIN_B, T1)).toBeNull();
    expect((await s.liveAcksFor([7])).get(7)?.acknowledgedBy).toBe(ADMIN_A);
  });
});

describe("liveAcksFor is exact about absence", () => {
  it("omits incidents with no live ack rather than fabricating one", async () => {
    const s = store();
    await s.acknowledge(7, ADMIN_A, null, T0);
    const live = await s.liveAcksFor([7, 8, 9]);
    expect([...live.keys()]).toEqual([7]);
    // Not `{ 8: null }` and not a default record: an incident with no ack has
    // no row, and the feed renders "unacknowledged" from the absence.
    expect(live.get(8)).toBeUndefined();
  });

  it("returns an empty map for an empty id list without querying", async () => {
    expect((await store().liveAcksFor([])).size).toBe(0);
  });
});

describe("the request body carries no actor, and is bounded (invariant 11)", () => {
  it("has no field through which an acknowledging address could be supplied", () => {
    const parsed = ackBodySchema.parse({ incident_id: 7, action: "acknowledge" });
    expect(Object.keys(parsed).sort()).toEqual(["action", "incident_id"]);
    // An address in the body is stripped, not honoured: zod's default object
    // behaviour drops unknown keys, so even a forged field cannot reach the
    // store — the session address is the only actor there is.
    const forged = ackBodySchema.parse({
      incident_id: 7,
      action: "acknowledge",
      acknowledged_by: ADMIN_B,
    }) as Record<string, unknown>;
    expect(forged["acknowledged_by"]).toBeUndefined();
  });

  it("rejects an over-long note rather than truncating it", () => {
    const ok = ackBodySchema.safeParse({
      incident_id: 7,
      action: "acknowledge",
      note: "x".repeat(MAX_ACK_NOTE_LENGTH),
    });
    expect(ok.success).toBe(true);
    const over = ackBodySchema.safeParse({
      incident_id: 7,
      action: "acknowledge",
      note: "x".repeat(MAX_ACK_NOTE_LENGTH + 1),
    });
    // Rejected, never clamped: a silently shortened operator note would be a
    // record of something nobody wrote.
    expect(over.success).toBe(false);
  });

  it("rejects an unknown action and a malformed id", () => {
    expect(ackBodySchema.safeParse({ incident_id: 7, action: "delete" }).success).toBe(false);
    expect(ackBodySchema.safeParse({ incident_id: -1, action: "acknowledge" }).success).toBe(false);
    expect(ackBodySchema.safeParse({ incident_id: "7", action: "acknowledge" }).success).toBe(
      false,
    );
  });
});

describe("the web tier never writes `incidents` (invariant 10)", () => {
  it("touches exactly one Prisma model, and it is in the `app` schema", () => {
    // The grant boundary is the mechanism (`app_writer` has no `indexed`
    // grants; the standing grant-boundary integration test proves it). This
    // asserts the half that lives in this repo's source: the store's Prisma
    // surface names `incidentAck` and nothing else — in particular no
    // `incident` model, which is what a well-meaning "close the incident too"
    // change would reach for.
    const source = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "app",
        "lib",
        "models",
        "incident-acks.server.ts",
      ),
      "utf8",
    );
    const models = new Set(
      [...source.matchAll(/this\.prisma\.(\w+)\./g)].map((match) => match[1]!),
    );
    expect([...models]).toEqual(["incidentAck"]);
  });
});
