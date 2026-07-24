// Notifier worker gate (plan 6.2 §3 commit B, §4.5 exactly-once). Drives the
// pure tick over the InMemoryAlertStore + a fake fetch returning fixture
// envelopes + a fixed clock — no Postgres, no network. Covers: presence
// filter, opt-out suppression, default-off opt-in fan-out, incident→kind
// mapping, the two-terminal-legs case, tick-twice idempotency (the unique
// constraint absorbs a cursor-ignoring re-scan), API-down isolation, cursor
// advance, and the retention sweep riding the tick.

import { describe, expect, it } from "vitest";
import { InMemoryAlertStore } from "~/lib/models/alerts.server";
import {
  EPOCHS_PAGE_LIMIT,
  parseRedemptionsCursor,
  RETENTION_ABSOLUTE_DAYS,
  runNavSteps,
  runRedemptions,
  runTick,
  type Logger,
  type NotifierDeps,
} from "../notifier/index.ts";

const NOW = new Date("2026-07-24T00:00:00Z");
const OWNER = "pb1owner";
const OWNER2 = "pb1owner2";
const OPERATOR = "pb1operator";
const SUBSCRIBER = "pb1subscriber";

const silentLog: Logger = { info: () => {}, error: () => {} };

function envelope(data: unknown): unknown {
  return {
    data,
    meta: { chain_height: 1000, indexed_height: 1000, generated_at: NOW.toISOString(), source: "indexed" },
  };
}

/** Default fixture bodies keyed by which internal/public route the URL hits. */
interface Fixtures {
  redemptions?: unknown[];
  incidents?: unknown[];
  arrears?: unknown[];
  epochs?: unknown[];
  /** Streams whose fetch should throw (API-down simulation). */
  down?: Set<string>;
}

function makeFetch(fx: Fixtures): NotifierDeps["fetchJson"] {
  return async (url) => {
    if (url.includes("/redemptions")) {
      if (fx.down?.has("redemptions")) throw new Error("API down");
      return envelope(fx.redemptions ?? []);
    }
    if (url.includes("/incidents")) {
      if (fx.down?.has("incidents")) throw new Error("API down");
      return envelope(fx.incidents ?? []);
    }
    if (url.includes("/arrears")) {
      if (fx.down?.has("arrears")) throw new Error("API down");
      return envelope(fx.arrears ?? []);
    }
    if (url.includes("/epochs")) {
      if (fx.down?.has("nav_step")) throw new Error("API down");
      return envelope(fx.epochs ?? []);
    }
    throw new Error(`unexpected url ${url}`);
  };
}

function makeDeps(store: InMemoryAlertStore, fx: Fixtures): NotifierDeps {
  return {
    store,
    fetchJson: makeFetch(fx),
    assertionKey: "notifier-test-assertion-key-0123456789ab",
    apiBase: "http://api.test",
    factLimit: 200,
    now: () => NOW,
    log: silentLog,
  };
}

function redemption(overrides: Partial<Record<string, unknown>> & { request_id: string; owner: string }): unknown {
  return {
    status: "matured",
    enqueued_at: "2026-05-01T00:00:00Z",
    expedited_at: null,
    matured_at: "2026-05-20T00:00:00Z",
    refunded_at: null,
    last_height: 100,
    ...overrides,
  };
}

async function allFor(store: InMemoryAlertStore, address: string) {
  return store.listNotifications(address, { limit: 100, offset: 0 });
}

describe("notifier: redemption_update (default-on)", () => {
  it("notifies a present owner who has not opted out", async () => {
    const store = new InMemoryAlertStore(() => NOW);
    store.setPresent(OWNER);
    await runTick(makeDeps(store, { redemptions: [redemption({ request_id: "r1", owner: OWNER })] }));
    const rows = await allFor(store, OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("redemption_update");
    expect(rows[0]!.payload).toEqual({ request_id: "r1", event: "matured" });
  });

  it("does NOT notify an owner with no app presence (data minimization)", async () => {
    const store = new InMemoryAlertStore(() => NOW); // OWNER not present
    await runTick(makeDeps(store, { redemptions: [redemption({ request_id: "r1", owner: OWNER })] }));
    expect(await allFor(store, OWNER)).toHaveLength(0);
  });

  it("suppresses when the owner opted out (enabled=false override)", async () => {
    const store = new InMemoryAlertStore(() => NOW);
    store.setPresent(OWNER);
    await store.upsertRule(OWNER, "redemption_update", false);
    await runTick(makeDeps(store, { redemptions: [redemption({ request_id: "r1", owner: OWNER })] }));
    expect(await allFor(store, OWNER)).toHaveLength(0);
  });

  it("emits two notifications for a request that matured then refunded", async () => {
    const store = new InMemoryAlertStore(() => NOW);
    store.setPresent(OWNER);
    await runTick(
      makeDeps(store, {
        redemptions: [
          redemption({ request_id: "r1", owner: OWNER, matured_at: "2026-05-20T00:00:00Z", refunded_at: "2026-06-01T00:00:00Z" }),
        ],
      }),
    );
    const events = (await allFor(store, OWNER)).map((n) => (n.payload as { event: string }).event).sort();
    expect(events).toEqual(["matured", "refunded"]);
  });
});

describe("notifier: exactly-once (the unique constraint, not the cursor)", () => {
  it("ticking twice with the SAME facts inserts no duplicates", async () => {
    const store = new InMemoryAlertStore(() => NOW);
    store.setPresent(OWNER);
    const fx = { redemptions: [redemption({ request_id: "r1", owner: OWNER })] };
    const first = await runTick(makeDeps(store, fx));
    // Second tick: the fake IGNORES the cursor and returns the same fact — the
    // unique constraint (not the cursor) is what prevents a double-delivery.
    const second = await runTick(makeDeps(store, fx));
    expect(first.inserted.redemptions).toBe(1);
    expect(second.inserted.redemptions).toBe(0);
    expect(await allFor(store, OWNER)).toHaveLength(1);
  });

  it("advances the compound cursor to the page's last (height, request_id)", async () => {
    const store = new InMemoryAlertStore(() => NOW);
    store.setPresent(OWNER);
    await runTick(
      makeDeps(store, {
        redemptions: [
          redemption({ request_id: "r1", owner: OWNER, last_height: 100 }),
          redemption({ request_id: "r2", owner: OWNER, last_height: 250 }),
        ],
      }),
    );
    expect(await store.getCheckpoint("redemptions")).toBe("250:r2");
  });

  it("pages through a same-height burst without losing the overflow", async () => {
    // Mass maturation at an epoch settlement: MANY redemptions share one
    // last_height. With factLimit below the burst size, the compound
    // `(since_height, after_id)` cursor must resume INSIDE the height — a
    // height-only strictly-greater cursor would skip the overflow forever.
    const store = new InMemoryAlertStore(() => NOW);
    store.setPresent(OWNER);
    const burst = ["req-a", "req-b", "req-c"].map((id) =>
      redemption({ request_id: id, owner: OWNER, last_height: 500 }),
    ) as Array<{ request_id: string; last_height: number }>;
    // A fetch honoring the API's keyset semantics ((height, id) ascending).
    const fetchJson: NotifierDeps["fetchJson"] = async (url) => {
      const params = new URL(url).searchParams;
      const sinceHeight = Number(params.get("since_height") ?? "0");
      const afterId = params.get("after_id") ?? "";
      const limit = Number(params.get("limit") ?? "200");
      const page = burst
        .filter((f) => f.last_height > sinceHeight || (f.last_height === sinceHeight && f.request_id > afterId))
        .slice(0, limit);
      return envelope(page);
    };
    const deps: NotifierDeps = { ...makeDeps(store, {}), fetchJson, factLimit: 2 };

    const first = await runRedemptions(deps);
    expect(first).toBe(2);
    expect(await store.getCheckpoint("redemptions")).toBe("500:req-b"); // resume point
    const second = await runRedemptions(deps);
    expect(second).toBe(1); // the overflow row, not skipped
    expect(await allFor(store, OWNER)).toHaveLength(3);
  });

  it("degrades a legacy or garbage redemptions cursor to a re-scan", () => {
    expect(parseRedemptionsCursor("250")).toEqual({ height: 250, afterId: "" }); // legacy height-only
    expect(parseRedemptionsCursor("500:req:with:colons")).toEqual({ height: 500, afterId: "req:with:colons" });
    expect(parseRedemptionsCursor(null)).toEqual({ height: 0, afterId: "" });
    expect(parseRedemptionsCursor("garbage")).toEqual({ height: 0, afterId: "" });
  });
});

describe("notifier: operator_arrears (default-on)", () => {
  it("notifies a present operator; suppresses an opted-out one", async () => {
    const store = new InMemoryAlertStore(() => NOW);
    store.setPresent(OPERATOR);
    const arrears = [{ valoper: "pbvaloper1aaa", operator: OPERATOR, epoch_index: 12, commission_due: "7" }];
    await runTick(makeDeps(store, { arrears }));
    expect(await allFor(store, OPERATOR)).toHaveLength(1);
    expect((await allFor(store, OPERATOR))[0]!.payload).toEqual({ valoper: "pbvaloper1aaa", epoch_index: 12 });

    await store.upsertRule(OPERATOR, "operator_arrears", false);
    // Same epoch again → dedupe already covers it, but also opted out now.
    await runTick(makeDeps(store, { arrears }));
    expect(await allFor(store, OPERATOR)).toHaveLength(1); // unchanged
  });
});

describe("notifier: incidents (default-off, opt-in fan-out + mapping)", () => {
  it("fans a mapped incident to its opt-in subscribers only", async () => {
    const store = new InMemoryAlertStore(() => NOW);
    await store.upsertRule(SUBSCRIBER, "vault_status", true); // opted in
    const incidents = [
      { id: 1, kind: "vault_paused", severity: "critical", dedupe_key: "vault:1", opened_at: NOW.toISOString(), opened_height: 10 },
      { id: 2, kind: "indexer_lag", severity: "warning", dedupe_key: "lag:1", opened_at: NOW.toISOString(), opened_height: 20 }, // unmapped → nothing
    ];
    await runTick(makeDeps(store, { incidents }));
    const rows = await allFor(store, SUBSCRIBER);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("vault_status");
    expect(rows[0]!.payload).toEqual({ incident_kind: "vault_paused" });
    expect(rows[0]!.dedupeKey).toBe("incident:vault_paused:vault:1");
  });

  it("maps jail_report to validator_set_incident and skips non-subscribers", async () => {
    const store = new InMemoryAlertStore(() => NOW);
    await store.upsertRule(SUBSCRIBER, "validator_set_incident", true);
    const incidents = [
      { id: 3, kind: "jail_report", severity: "warning", dedupe_key: "jail:v", opened_at: NOW.toISOString(), opened_height: 30 },
    ];
    await runTick(makeDeps(store, { incidents }));
    expect(await allFor(store, SUBSCRIBER)).toHaveLength(1);
    expect(await allFor(store, OWNER2)).toHaveLength(0); // not subscribed
  });
});

describe("notifier: nav_step_posted (default-off, cursor windows epochs)", () => {
  it("notifies opt-ins for epochs past the cursor only", async () => {
    const store = new InMemoryAlertStore(() => NOW);
    await store.upsertRule(SUBSCRIBER, "nav_step_posted", true);
    const epochs = [
      { epoch_index: 12, ended_at: NOW.toISOString(), nav: "1.0", tvv: "1000", net_apr_bps: 400 },
      { epoch_index: 11, ended_at: NOW.toISOString(), nav: "1.0", tvv: "1000", net_apr_bps: 400 },
    ];
    // First tick: both epochs are new (cursor 0) → two notifications.
    await runTick(makeDeps(store, { epochs }));
    expect(await allFor(store, SUBSCRIBER)).toHaveLength(2);
    expect(await store.getCheckpoint("nav_step")).toBe("12");
    // Second tick: same epochs, cursor now 12 → nothing new.
    const second = await runTick(makeDeps(store, { epochs }));
    expect(second.inserted.nav_step).toBe(0);
  });

  it("clamps the public /epochs page to its cap even when factLimit exceeds it", async () => {
    // factLimit may lawfully be up to 500 (the alert-facts ceiling), but the
    // public /epochs limit rejects (never clamps) past MAX_PAGE_LIMIT — an
    // unclamped request would 400 the nav stream on every tick.
    const store = new InMemoryAlertStore(() => NOW);
    let requestedLimit: number | null = null;
    const deps: NotifierDeps = {
      ...makeDeps(store, {}),
      factLimit: 500,
      fetchJson: async (url) => {
        requestedLimit = Number(new URL(url).searchParams.get("limit"));
        return envelope([]);
      },
    };
    await runNavSteps(deps);
    expect(requestedLimit).toBe(EPOCHS_PAGE_LIMIT);
  });
});

describe("notifier: failure isolation + retention", () => {
  it("one stream's API error never blocks the others; its cursor is unmoved", async () => {
    const store = new InMemoryAlertStore(() => NOW);
    store.setPresent(OWNER, OPERATOR);
    const result = await runTick(
      makeDeps(store, {
        down: new Set(["redemptions"]),
        arrears: [{ valoper: "pbvaloper1aaa", operator: OPERATOR, epoch_index: 12, commission_due: "7" }],
      }),
    );
    expect(result.errors.redemptions).toBeDefined();
    expect(result.inserted.arrears).toBe(1); // arrears still processed
    expect(await store.getCheckpoint("redemptions")).toBeNull(); // never committed
    expect(await allFor(store, OPERATOR)).toHaveLength(1);
  });

  it("the retention sweep on the tick deletes aged notifications", async () => {
    const store = new InMemoryAlertStore(() => NOW);
    // A read notification older than the absolute window (delivered long ago).
    store.seed({
      address: OWNER,
      kind: "nav_step_posted",
      dedupeKey: "epoch:1",
      payload: { epoch_index: 1 },
      deliveredAt: new Date(NOW.getTime() - (RETENTION_ABSOLUTE_DAYS + 1) * 24 * 60 * 60 * 1000),
      readAt: null,
    });
    expect(await allFor(store, OWNER)).toHaveLength(1);
    const result = await runTick(makeDeps(store, {}));
    expect(result.swept).toBe(1);
    expect(await allFor(store, OWNER)).toHaveLength(0);
  });
});
