// Web Push subscription behavior (§4.2). Exercises the
// push feature-server (the seam the `/push/subscription` route calls after
// requireSession) over the in-memory store, plus the route boundary schema.
// The acting address and session id come only from the session in the route;
// the anonymous → 401 and session-wins cases join test/session-scope.test.ts
// (the shared requireSession guard the route uses).
//
// The security shape this pins (SECURITY.md accepted exception — opaque,
// revocable tokens): opt-in only creates; replace-by-session never accumulates;
// a per-address cap evicts the oldest; DELETE removes ONLY the session's rows;
// the body is bounded (https endpoint, capped base64url keys, no extra fields).

import { beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "~/config/config.server";
import {
  getPushStore,
  PrismaPushStore,
  PUSH_SUBSCRIPTIONS_PER_ADDRESS_CAP,
  resetPushStoreForTests,
  UPSERT_SERIALIZATION_ATTEMPTS,
  type InMemoryPushStore,
} from "~/lib/models/push.server";
import {
  deleteSubscriptionsForSession,
  pushSubscriptionBodySchema,
  saveSubscription,
} from "~/push/push.server";

const config = loadConfig({
  APP_ENV: "development",
  CHAIN_ID: "chain-dev",
  LCD_URL: "http://lcd.mock:1317",
  CONTRACT_ADDRESS: "tp14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s96lrg8",
  VAULT_ADDRESS: "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad",
  CONSOLE_URL: "https://console.example",
  CONSOLE_CHAIN_ID: "chain-dev",
  API_URL: "http://api.mock:8787",
} as NodeJS.ProcessEnv); // no DATABASE_URL → the in-memory store

const A = "tp1aaa";
const B = "tp1bbb";
const P256 = "BPa1".padEnd(87, "x"); // base64url-shaped, within the 256 cap
const AUTH = "c2VjcmV0"; // base64url-shaped, within the 128 cap

function body(endpoint: string, keys = { p256dh: P256, auth: AUTH }) {
  return { endpoint, keys };
}

async function store(): Promise<InMemoryPushStore> {
  resetPushStoreForTests();
  return (await getPushStore(config)) as InMemoryPushStore;
}

beforeEach(() => resetPushStoreForTests());

describe("route boundary schema (reject, never clamp)", () => {
  it("accepts the W3C triple: https endpoint + base64url p256dh/auth", () => {
    expect(pushSubscriptionBodySchema.safeParse(body("https://push.example/ep/1")).success).toBe(true);
  });

  it("rejects a non-https endpoint", () => {
    expect(pushSubscriptionBodySchema.safeParse(body("http://push.example/ep/1")).success).toBe(false);
    expect(pushSubscriptionBodySchema.safeParse(body("ftp://push.example/ep/1")).success).toBe(false);
  });

  it("rejects an oversized endpoint (> 1024) and oversized keys", () => {
    const huge = "https://push.example/" + "z".repeat(1100);
    expect(pushSubscriptionBodySchema.safeParse(body(huge)).success).toBe(false);
    expect(
      pushSubscriptionBodySchema.safeParse(body("https://push.example/ep", { p256dh: "z".repeat(300), auth: AUTH }))
        .success,
    ).toBe(false);
    expect(
      pushSubscriptionBodySchema.safeParse(body("https://push.example/ep", { p256dh: P256, auth: "z".repeat(200) }))
        .success,
    ).toBe(false);
  });

  it("rejects non-base64url key material and empty keys", () => {
    expect(
      pushSubscriptionBodySchema.safeParse(body("https://push.example/ep", { p256dh: "has spaces!", auth: AUTH }))
        .success,
    ).toBe(false);
    expect(
      pushSubscriptionBodySchema.safeParse(body("https://push.example/ep", { p256dh: "", auth: AUTH })).success,
    ).toBe(false);
  });

  it("rejects any extra field — the App stores exactly the triple (.strict)", () => {
    expect(
      pushSubscriptionBodySchema.safeParse({
        endpoint: "https://push.example/ep",
        keys: { p256dh: P256, auth: AUTH },
        expirationTime: 123, // W3C toJSON() carries this; we must not store it
      }).success,
    ).toBe(false);
    expect(
      pushSubscriptionBodySchema.safeParse({
        endpoint: "https://push.example/ep",
        keys: { p256dh: P256, auth: AUTH, extra: "x" },
      }).success,
    ).toBe(false);
  });
});

describe("opt-in upsert semantics", () => {
  it("replace-by-session: a new endpoint for a session replaces, never accumulates", async () => {
    const s = await store();
    await saveSubscription(config, A, "sess-1", pushSubscriptionBodySchema.parse(body("https://push.example/ep/1")));
    await saveSubscription(config, A, "sess-1", pushSubscriptionBodySchema.parse(body("https://push.example/ep/2")));
    expect(await s.countForAddress(A)).toBe(1);
    expect(s.listForAddressSync(A).map((r) => r.endpoint)).toEqual(["https://push.example/ep/2"]);
  });

  it("a re-subscription with the same endpoint under a new session re-homes it, never duplicating", async () => {
    const s = await store();
    await saveSubscription(config, A, "sess-1", pushSubscriptionBodySchema.parse(body("https://push.example/ep/1")));
    await saveSubscription(config, A, "sess-2", pushSubscriptionBodySchema.parse(body("https://push.example/ep/1")));
    expect(await s.countForAddress(A)).toBe(1);
    // The row now belongs to sess-2 (deleting sess-1 removes nothing).
    expect(await deleteSubscriptionsForSession(config, "sess-1")).toBe(0);
    expect(await s.countForAddress(A)).toBe(1);
  });

  it("caps subscriptions per address, evicting the oldest past the cap", async () => {
    const s = await store();
    const total = PUSH_SUBSCRIPTIONS_PER_ADDRESS_CAP + 2;
    for (let i = 0; i < total; i++) {
      await saveSubscription(
        config,
        A,
        `sess-${i}`,
        pushSubscriptionBodySchema.parse(body(`https://push.example/ep/${i}`)),
      );
    }
    expect(await s.countForAddress(A)).toBe(PUSH_SUBSCRIPTIONS_PER_ADDRESS_CAP);
    // The two oldest endpoints (0, 1) were evicted; the newest survive.
    const endpoints = s.listForAddressSync(A).map((r) => r.endpoint);
    expect(endpoints).not.toContain("https://push.example/ep/0");
    expect(endpoints).toContain(`https://push.example/ep/${total - 1}`);
  });
});

// ── PrismaPushStore query shaping (the alerts-models capturing precedent) ──
// Pins the two PR-review mechanisms the in-memory store can't express:
// SERIALIZABLE upsert (+ bounded P2034 retry) and the sweep's anti-join SQL.

interface Call {
  method: string;
  args: unknown;
}

function capturingPrisma(recorded: Call[], opts?: { conflicts?: number }) {
  let conflictsLeft = opts?.conflicts ?? 0;
  const delegate = {
    upsert: (args: unknown) => {
      recorded.push({ method: "upsert", args });
      return Promise.resolve({});
    },
    deleteMany: (args: unknown) => {
      recorded.push({ method: "deleteMany", args });
      return Promise.resolve({ count: 0 });
    },
    findMany: (args: unknown) => {
      recorded.push({ method: "findMany", args });
      return Promise.resolve([]);
    },
    count: (args: unknown) => {
      recorded.push({ method: "count", args });
      return Promise.resolve(0);
    },
  };
  return {
    pushSubscription: delegate,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
      recorded.push({ method: "$transaction", args: options });
      if (conflictsLeft > 0) {
        conflictsLeft -= 1;
        const err = new Error("write conflict") as Error & { code: string };
        err.code = "P2034"; // Prisma's serialization-failure code
        throw err;
      }
      return fn({ pushSubscription: delegate });
    },
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      recorded.push({ method: "$executeRaw", args: { sql: strings.join("$?"), values } });
      return Promise.resolve(0);
    },
  };
}

describe("PrismaPushStore query shaping (concurrency + invariant sweep)", () => {
  const SUB = { endpoint: "https://push.example/ep/1", p256dh: P256, auth: AUTH };

  it("upsertForSession runs its read-check-evict transaction SERIALIZABLE", async () => {
    const recorded: Call[] = [];
    const s = new PrismaPushStore(capturingPrisma(recorded) as never);
    await s.upsertForSession(A, "sess-1", SUB);
    const txn = recorded.find((c) => c.method === "$transaction")!;
    expect(txn.args).toEqual({ isolationLevel: "Serializable" });
  });

  it("retries a serialization conflict (P2034), then surfaces a persistent one", async () => {
    // Two conflicts then success: the caller never sees them.
    const recorded: Call[] = [];
    const s = new PrismaPushStore(capturingPrisma(recorded, { conflicts: UPSERT_SERIALIZATION_ATTEMPTS - 1 }) as never);
    await s.upsertForSession(A, "sess-1", SUB);
    expect(recorded.filter((c) => c.method === "$transaction")).toHaveLength(UPSERT_SERIALIZATION_ATTEMPTS);
    // Persistent conflict: bounded — rethrown after the attempt budget.
    const recorded2: Call[] = [];
    const s2 = new PrismaPushStore(capturingPrisma(recorded2, { conflicts: 99 }) as never);
    await expect(s2.upsertForSession(A, "sess-1", SUB)).rejects.toThrow("write conflict");
    expect(recorded2.filter((c) => c.method === "$transaction")).toHaveLength(UPSERT_SERIALIZATION_ATTEMPTS);
  });

  it("sweepOrphans is ONE anti-join DELETE mirroring the session liveness rule", async () => {
    const recorded: Call[] = [];
    const s = new PrismaPushStore(capturingPrisma(recorded) as never);
    const now = new Date("2026-07-24T12:00:00Z");
    await s.sweepOrphans(now);
    const raw = recorded.find((c) => c.method === "$executeRaw");
    expect(raw).toBeDefined();
    const { sql, values } = raw!.args as { sql: string; values: unknown[] };
    expect(sql).toContain('DELETE FROM "app"."push_subscriptions"');
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain('"app"."sessions"');
    expect(sql).toContain('"expiresAt"');
    expect(sql).toContain('"lastRefreshAt"');
    // Both liveness bounds ride as PARAMETERS: now + the 24 h idle cutoff.
    expect(values).toEqual([now, new Date("2026-07-23T12:00:00Z")]);
  });
});

describe("opt-out / deletion is session-scoped", () => {
  it("DELETE removes only the session's rows, never another session's", async () => {
    const s = await store();
    // Same address, two browsers (two sessions), distinct endpoints.
    await saveSubscription(config, A, "sess-1", pushSubscriptionBodySchema.parse(body("https://push.example/ep/1")));
    await saveSubscription(config, A, "sess-2", pushSubscriptionBodySchema.parse(body("https://push.example/ep/2")));
    expect(await s.countForAddress(A)).toBe(2);

    const deleted = await deleteSubscriptionsForSession(config, "sess-1");
    expect(deleted).toBe(1);
    expect(s.listForAddressSync(A).map((r) => r.endpoint)).toEqual(["https://push.example/ep/2"]);
  });

  it("deleting a session with no subscriptions is a no-op (idempotent opt-out)", async () => {
    await store();
    expect(await deleteSubscriptionsForSession(config, "never-subscribed")).toBe(0);
  });
});
