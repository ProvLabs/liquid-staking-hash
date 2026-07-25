// AlertStore contract (plan 6.2 §3 commit B). The behavioral contract runs
// against the InMemoryAlertStore (the storeless posture routes/notifier use in
// tests); the security-critical query shaping of the Prisma implementation
// (mark-read is ALWAYS address-scoped; commitTick inserts with skipDuplicates
// AND advances the cursor in ONE transaction) is asserted against a capturing
// fake, so both implementations are exercised without a live Postgres.

import { describe, expect, it } from "vitest";
import { InMemoryAlertStore, PrismaAlertStore } from "~/lib/models/alerts.server";
import { effectiveSettings, isKindEnabled, type AlertKind, type Candidate } from "~/lib/services/alerts.server";

const NOW = new Date("2026-07-24T00:00:00Z");
const A = "pb1aaa";
const B = "pb1bbb";

function candidate(address: string, dedupeKey: string): Candidate {
  return { address, kind: "redemption_update", dedupeKey, payload: { request_id: dedupeKey, event: "matured" } };
}

describe("effective-settings merge (absence = default)", () => {
  it("defaults on for the R2 set, off for the rest, with overrides winning", () => {
    expect(isKindEnabled("redemption_update", new Map())).toBe(true);
    expect(isKindEnabled("operator_arrears", new Map())).toBe(true);
    expect(isKindEnabled("nav_step_posted", new Map())).toBe(false);
    expect(isKindEnabled("vault_status", new Map())).toBe(false);
    // Overrides both directions.
    expect(isKindEnabled("redemption_update", new Map([["redemption_update", false]]))).toBe(false);
    expect(isKindEnabled("nav_step_posted", new Map([["nav_step_posted", true]]))).toBe(true);
  });

  it("effectiveSettings covers the closed kind list with is-default flags", () => {
    const view = effectiveSettings(new Map<AlertKind, boolean>([["nav_step_posted", true]]));
    expect(view).toHaveLength(5);
    const nav = view.find((v) => v.kind === "nav_step_posted")!;
    expect(nav).toEqual({ kind: "nav_step_posted", enabled: true, isDefault: false });
    const red = view.find((v) => v.kind === "redemption_update")!;
    expect(red).toEqual({ kind: "redemption_update", enabled: true, isDefault: true });
  });
});

describe("InMemoryAlertStore contract", () => {
  it("rules: absence, opt-in, opt-out, update", async () => {
    const store = new InMemoryAlertStore(() => NOW);
    expect(await store.listOverrides(A)).toEqual(new Map());
    await store.upsertRule(A, "nav_step_posted", true);
    await store.upsertRule(A, "redemption_update", false);
    expect(await store.listOverrides(A)).toEqual(
      new Map<AlertKind, boolean>([
        ["nav_step_posted", true],
        ["redemption_update", false],
      ]),
    );
    await store.upsertRule(A, "nav_step_posted", false); // update
    expect((await store.listOverrides(A)).get("nav_step_posted")).toBe(false);
  });

  it("commitTick returns the NEWLY-INSERTED candidates, skipping duplicates, and advances the cursor", async () => {
    const store = new InMemoryAlertStore(() => NOW);
    const n1 = await store.commitTick("redemptions", "100", [candidate(A, "r1"), candidate(A, "r2")]);
    expect(n1).toHaveLength(2); // both new (the push fan-out set, plan §2.3)
    const n2 = await store.commitTick("redemptions", "250", [candidate(A, "r2"), candidate(A, "r3")]);
    expect(n2).toHaveLength(1); // r2 already present → only r3 returned
    expect(n2[0]!.dedupeKey).toBe("r3");
    expect(await store.getCheckpoint("redemptions")).toBe("250");
    expect(await store.countUnread(A)).toBe(3);
  });

  it("notifications: newest-first pagination + unread count", async () => {
    const store = new InMemoryAlertStore(() => NOW);
    await store.commitTick("s", "1", [candidate(A, "r1"), candidate(A, "r2"), candidate(A, "r3")]);
    const page = await store.listNotifications(A, { limit: 2, offset: 0 });
    expect(page.map((n) => n.dedupeKey)).toEqual(["r3", "r2"]); // newest id first
    expect(await store.countUnread(A)).toBe(3);
  });

  it("markRead is address-scoped: never touches another address's rows", async () => {
    const store = new InMemoryAlertStore(() => NOW);
    await store.commitTick("s", "1", [candidate(A, "r1"), candidate(B, "r1")]);
    const aRows = await store.listNotifications(A, { limit: 10, offset: 0 });
    // Ask A to mark B's id (and A's own): only A's is marked.
    const bRows = await store.listNotifications(B, { limit: 10, offset: 0 });
    const marked = await store.markRead(A, { ids: [aRows[0]!.id, bRows[0]!.id] }, NOW);
    expect(marked).toBe(1);
    expect(await store.countUnread(A)).toBe(0);
    expect(await store.countUnread(B)).toBe(1); // untouched
  });

  it("markRead {all} marks every unread row for the address", async () => {
    const store = new InMemoryAlertStore(() => NOW);
    await store.commitTick("s", "1", [candidate(A, "r1"), candidate(A, "r2")]);
    expect(await store.markRead(A, { all: true }, NOW)).toBe(2);
    expect(await store.countUnread(A)).toBe(0);
  });

  it("presence + opt-in/opt-out queries", async () => {
    const store = new InMemoryAlertStore(() => NOW);
    store.setPresent(A);
    expect(await store.filterPresent([A, B])).toEqual(new Set([A]));
    await store.upsertRule(A, "redemption_update", false);
    await store.upsertRule(B, "vault_status", true);
    expect(await store.optedOutAddresses("redemption_update", [A, B])).toEqual(new Set([A]));
    expect(await store.optInAddresses("vault_status")).toEqual(new Set([B]));
  });

  it("sweep deletes read-old and delivered-old rows in a bounded batch", async () => {
    const store = new InMemoryAlertStore(() => NOW);
    const old = new Date(NOW.getTime() - 200 * 24 * 60 * 60 * 1000);
    store.seed({ address: A, kind: "nav_step_posted", dedupeKey: "old", payload: {}, deliveredAt: old, readAt: null });
    store.seed({ address: A, kind: "nav_step_posted", dedupeKey: "fresh", payload: {}, deliveredAt: NOW, readAt: null });
    const deleted = await store.sweep(new Date(NOW.getTime() - 90 * 864e5), new Date(NOW.getTime() - 180 * 864e5), 500);
    expect(deleted).toBe(1);
    expect((await store.listNotifications(A, { limit: 10, offset: 0 })).map((n) => n.dedupeKey)).toEqual(["fresh"]);
  });
});

// ── PrismaAlertStore: security-critical query shaping (capturing fake) ───────

interface Call {
  method: string;
  args: unknown;
}

function capturingPrisma(recorded: Call[]) {
  const tx = {
    notification: {
      // createManyAndReturn = INSERT … ON CONFLICT DO NOTHING RETURNING; the
      // fake has no conflicts, so it echoes back all data rows as "inserted".
      createManyAndReturn: (args: unknown) => {
        recorded.push({ method: "createManyAndReturn", args });
        return Promise.resolve((args as { data: Array<Record<string, unknown>> }).data);
      },
    },
    notifierCheckpoint: {
      upsert: (args: unknown) => {
        recorded.push({ method: "checkpoint.upsert", args });
        return Promise.resolve({});
      },
    },
  };
  return {
    notification: {
      updateMany: (args: unknown) => {
        recorded.push({ method: "updateMany", args });
        return Promise.resolve({ count: 1 });
      },
    },
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => {
      recorded.push({ method: "$transaction", args: null });
      return fn(tx);
    },
  };
}

describe("PrismaAlertStore query shaping (security-critical)", () => {
  it("markRead always scopes the WHERE by address (both selectors)", async () => {
    const recorded: Call[] = [];
    const store = new PrismaAlertStore(capturingPrisma(recorded) as never);
    await store.markRead(A, { all: true }, NOW);
    await store.markRead(A, { ids: [1n, 2n] }, NOW);
    const wheres = recorded.filter((c) => c.method === "updateMany").map((c) => (c.args as { where: Record<string, unknown> }).where);
    expect(wheres).toHaveLength(2);
    for (const where of wheres) {
      expect(where.address).toBe(A); // an id belonging to another address can never be touched
      expect(where.readAt).toBeNull();
    }
    // The id-selector variant additionally constrains id ∈ the given set.
    expect((wheres[1] as { id: { in: bigint[] } }).id.in).toEqual([1n, 2n]);
  });

  it("commitTick inserts skipDuplicates (RETURNING) AND upserts the checkpoint in one $transaction", async () => {
    const recorded: Call[] = [];
    const store = new PrismaAlertStore(capturingPrisma(recorded) as never);
    const n = await store.commitTick("redemptions", "250", [candidate(A, "r1")]);
    expect(n).toHaveLength(1); // the newly-inserted candidate (the push fan-out set)
    const order = recorded.map((c) => c.method);
    expect(order).toEqual(["$transaction", "createManyAndReturn", "checkpoint.upsert"]);
    const createMany = recorded.find((c) => c.method === "createManyAndReturn")!.args as { skipDuplicates: boolean };
    expect(createMany.skipDuplicates).toBe(true); // ON CONFLICT DO NOTHING = the exactly-once gate
    const cp = recorded.find((c) => c.method === "checkpoint.upsert")!.args as { where: { stream: string }; update: { cursor: string } };
    expect(cp.where.stream).toBe("redemptions");
    expect(cp.update.cursor).toBe("250");
  });

  it("commitTick with no candidates still advances the cursor (skips the insert)", async () => {
    const recorded: Call[] = [];
    const store = new PrismaAlertStore(capturingPrisma(recorded) as never);
    const n = await store.commitTick("nav_step", "12", []);
    expect(n).toHaveLength(0);
    expect(recorded.map((c) => c.method)).toEqual(["$transaction", "checkpoint.upsert"]); // no insert call
  });
});
