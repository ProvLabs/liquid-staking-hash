// Alert resource-route behavior (§4.6). Exercises the
// alerts feature-server (the seam the `/alerts/*` routes call after
// requireSession) over the in-memory store singleton: mark-read is
// address-scoped (never crosses addresses), the body/query schemas reject
// out-of-range input, and an unknown alert kind is a 400 (reject, never guess).
// The anonymous → 401 and session-wins cases live in test/session-scope.test.ts
// (they exercise the shared requireSession guard the routes use).

import { beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "~/config/config.server";
import {
  countUnread,
  loadEffectiveSettings,
  loadNotifications,
  markNotificationsRead,
  markReadBodySchema,
  MAX_NOTIFICATIONS_PAGE,
  notificationsPageSchema,
  ruleUpsertBodySchema,
  setAlertRule,
} from "~/alerts/alerts.server";
import {
  getAlertStore,
  resetAlertStoreForTests,
  type InMemoryAlertStore,
} from "~/lib/models/alerts.server";

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

async function seededStore(): Promise<InMemoryAlertStore> {
  resetAlertStoreForTests();
  const store = (await getAlertStore(config)) as InMemoryAlertStore;
  return store;
}

beforeEach(() => resetAlertStoreForTests());

describe("mark-read is address-scoped (§2.6)", () => {
  it("marking {all} for A never touches B's notifications", async () => {
    const store = await seededStore();
    await store.commitTick("s", "1", [
      {
        address: A,
        kind: "redemption_update",
        dedupeKey: "r1",
        payload: { request_id: "r1", event: "matured" },
      },
      {
        address: B,
        kind: "redemption_update",
        dedupeKey: "r1",
        payload: { request_id: "r1", event: "matured" },
      },
    ]);
    const result = await markNotificationsRead(config, A, { all: true });
    expect(result.marked).toBe(1);
    expect(result.unread).toBe(0);
    expect(await countUnread(config, B)).toBe(1); // B untouched
  });

  it("marking by ids ignores an id that belongs to another address", async () => {
    const store = await seededStore();
    await store.commitTick("s", "1", [
      { address: A, kind: "nav_step_posted", dedupeKey: "e1", payload: { epoch_index: 1 } },
      { address: B, kind: "nav_step_posted", dedupeKey: "e1", payload: { epoch_index: 1 } },
    ]);
    const bId = (await loadNotifications(config, B, 0)).notifications[0]!.id;
    // A tries to mark B's id: nothing happens for either (not A's row).
    const result = await markNotificationsRead(config, A, { ids: [bId] });
    expect(result.marked).toBe(0);
    expect(await countUnread(config, B)).toBe(1);
  });
});

describe("notifications listing + unread count", () => {
  it("lists only the address's own rows, newest first, with the unread count", async () => {
    const store = await seededStore();
    await store.commitTick("s", "1", [
      { address: A, kind: "nav_step_posted", dedupeKey: "e1", payload: { epoch_index: 1 } },
      { address: A, kind: "nav_step_posted", dedupeKey: "e2", payload: { epoch_index: 2 } },
      { address: B, kind: "nav_step_posted", dedupeKey: "e1", payload: { epoch_index: 1 } },
    ]);
    const { notifications, unread } = await loadNotifications(config, A, 0);
    expect(notifications.map((n) => (n.payload as { epoch_index: number }).epoch_index)).toEqual([
      2, 1,
    ]);
    expect(unread).toBe(2);
    // JSON-safe: id is a string, timestamps are ISO.
    expect(typeof notifications[0]!.id).toBe("string");
    expect(notifications[0]!.delivered_at).toMatch(/T/);
  });
});

describe("effective settings CRUD", () => {
  it("defaults on for the R2 set; an upsert flips one and persists", async () => {
    await seededStore();
    const initial = await loadEffectiveSettings(config, A);
    expect(initial.find((s) => s.kind === "redemption_update")).toEqual({
      kind: "redemption_update",
      enabled: true,
      isDefault: true,
    });
    expect(initial.find((s) => s.kind === "nav_step_posted")!.enabled).toBe(false);

    const updated = await setAlertRule(config, A, "redemption_update", false);
    expect(updated.find((s) => s.kind === "redemption_update")!.enabled).toBe(false);
    // Persisted: a fresh read reflects the override.
    const reread = await loadEffectiveSettings(config, A);
    expect(reread.find((s) => s.kind === "redemption_update")!.enabled).toBe(false);
  });
});

describe("route boundary schemas (reject, never clamp)", () => {
  it("mark-read body: ids bounded ≤ 100, numeric, or {all: true}", () => {
    expect(markReadBodySchema.safeParse({ all: true }).success).toBe(true);
    expect(markReadBodySchema.safeParse({ ids: ["1", "2"] }).success).toBe(true);
    expect(markReadBodySchema.safeParse({ ids: [] }).success).toBe(false); // min 1
    expect(markReadBodySchema.safeParse({ ids: ["x"] }).success).toBe(false); // non-numeric
    expect(
      markReadBodySchema.safeParse({ ids: Array.from({ length: 101 }, (_, i) => String(i)) })
        .success,
    ).toBe(false);
    expect(markReadBodySchema.safeParse({ all: false }).success).toBe(false);
  });

  it("rule upsert body: closed kind enum + boolean, unknown kind → invalid", () => {
    expect(ruleUpsertBodySchema.safeParse({ kind: "vault_status", enabled: true }).success).toBe(
      true,
    );
    expect(ruleUpsertBodySchema.safeParse({ kind: "not_a_kind", enabled: true }).success).toBe(
      false,
    );
    expect(ruleUpsertBodySchema.safeParse({ kind: "vault_status" }).success).toBe(false); // missing enabled
    expect(ruleUpsertBodySchema.safeParse({ kind: "vault_status", enabled: "yes" }).success).toBe(
      false,
    );
  });

  it("page query: non-negative integer, reject-never-clamp, bounded ceiling", () => {
    expect(notificationsPageSchema.safeParse("0").success).toBe(true);
    expect(notificationsPageSchema.safeParse("3").success).toBe(true);
    expect(notificationsPageSchema.safeParse("-1").success).toBe(false);
    expect(notificationsPageSchema.safeParse("1.5").success).toBe(false);
    expect(notificationsPageSchema.safeParse("abc").success).toBe(false);
    // The ceiling keeps the offset (pages × 30) inside the cross-system
    // MAX_PAGE_OFFSET posture — deep-pagination is rejected, never served.
    expect(notificationsPageSchema.safeParse(String(MAX_NOTIFICATIONS_PAGE)).success).toBe(true);
    expect(notificationsPageSchema.safeParse(String(MAX_NOTIFICATIONS_PAGE + 1)).success).toBe(
      false,
    );
  });
});
