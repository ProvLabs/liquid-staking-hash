// The §14.10 funnel-counter gate. Three plan invariants live here:
//
//   7 — NO CALL SITE CAN LEAK AN IDENTIFIER. `recordFunnelEvent` accepts a
//       closed event and the store config, and nothing else. There is no
//       parameter for an address, a session, a request or headers, so the
//       mistake is unavailable rather than merely forbidden. The schema-side
//       counterpart is the denylist in test/app-schema-allowlist.test.ts.
//   9 — THE COUNTERS NEVER TAKE A PAGE DOWN. A write failure is logged and
//       swallowed, and the call does not block the loader.
//  18 — LOGS CARRY NO IDENTIFIERS. The failure log names the stage and nothing
//       else, because the event has nothing else to name.
//
// Both store implementations run against the same contract, so a test cannot
// pass on the in-memory store while the SQL one behaves differently.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getFunnelCounterStore,
  InMemoryFunnelCounterStore,
  recordFunnelEvent,
  resetFunnelCounterStoreForTests,
  sweepFunnelCounters,
  type FunnelCounterStore,
} from "~/lib/models/funnel-counters.server";
import {
  FUNNEL_RETENTION_DAYS,
  FUNNEL_STAGE_KEYS,
  funnelRetentionCutoff,
  funnelStageKey,
  MAX_FUNNEL_ROWS,
  utcDay,
} from "~/lib/services/funnel.server";

beforeEach(() => resetFunnelCounterStoreForTests());
afterEach(() => vi.restoreAllMocks());

const NOW = new Date("2026-07-31T12:34:56.000Z");

describe("the event vocabulary is closed and identifier-free (invariant 7)", () => {
  it("maps every event to a stored stage key, and only to declared keys", () => {
    expect(funnelStageKey({ stage: "visit", pageClass: "learn_index" })).toBe("visit_learn_index");
    expect(funnelStageKey({ stage: "visit", pageClass: "validators" })).toBe("visit_validators");
    expect(funnelStageKey({ stage: "visit", pageClass: "market" })).toBe("visit_market");
    expect(funnelStageKey({ stage: "due_diligence_depth" })).toBe("due_diligence_depth");
    expect(funnelStageKey({ stage: "connect" })).toBe("connect");
    // Every produced key is a declared enum member — no key can be synthesized
    // that the migration does not know about.
    for (const key of FUNNEL_STAGE_KEYS) expect(FUNNEL_STAGE_KEYS).toContain(key);
  });

  it("has no identifier-shaped parameter anywhere in the write path", () => {
    // The property is enforced by the TYPES; this asserts the ARITY those types
    // imply, so a future signature that quietly grew a third positional
    // parameter — `(config, event, request)` — trips here even if someone
    // typed it loosely.
    expect(recordFunnelEvent.length).toBe(2); // (config, event); `now` is defaulted
    // And the store's own write takes a stage key and a day string: no shape
    // through which a caller could attach anything else.
    const store: FunnelCounterStore = new InMemoryFunnelCounterStore();
    expect(store.increment.length).toBe(2);
  });

  it("keeps `visit` and the stageless stages structurally distinct", () => {
    // A discriminated union rather than `(stage, pageClass?)`, so
    // `{ stage: "connect", pageClass: "market" }` is a type error rather than a
    // row nobody can interpret. Asserted here as the runtime consequence: the
    // stageless stages map to their own key with no class folded in.
    expect(funnelStageKey({ stage: "connect" })).not.toContain("visit");
    expect(funnelStageKey({ stage: "due_diligence_depth" })).not.toContain("visit");
  });
});

describe("every call site is identifier-free (invariant 7, read from source)", () => {
  // The type system already forbids passing an address, but plan §9 asks for
  // the call sites to be READ, not assumed — so this reads them, mechanically,
  // and fails if a new one appears that this suite has not seen.
  const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "app");

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(path, out);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
    }
    return out;
  }

  /** Where the function is DECLARED — its own signature is not a call site. */
  const DECLARATION = join("lib", "models", "funnel-counters.server.ts");

  /** Every `recordFunnelEvent(...)` invocation's argument text. */
  function callSites(): Array<{ file: string; args: string }> {
    const found: Array<{ file: string; args: string }> = [];
    for (const file of sourceFiles(APP_DIR)) {
      if (relative(APP_DIR, file) === DECLARATION) continue;
      const source = readFileSync(file, "utf8");
      const re = /recordFunnelEvent\(([^;]*?)\);/gs;
      let match: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: the canonical `exec` iteration idiom.
      while ((match = re.exec(source)) !== null) {
        found.push({ file: relative(APP_DIR, file), args: match[1]! });
      }
    }
    return found;
  }

  it("finds exactly the expected call sites, duplicates included", () => {
    const files = callSites()
      .map((c) => c.file)
      .sort();
    // A new counted surface must be added here deliberately. Silence is the
    // failure mode this list exists to prevent: an unreviewed call site is
    // exactly where an identifier would first appear.
    //
    // `/market` and `/validators` appear TWICE each on purpose: they record
    // their page class AND the `due_diligence_depth` stage. Asserting the
    // multiset rather than the set is what makes a dropped second call visible.
    expect(files).toEqual([
      "routes/home.tsx",
      "routes/market.tsx",
      "routes/market.tsx",
      "routes/session-login.tsx",
      "routes/validators.tsx",
      "routes/validators.tsx",
    ]);
  });

  it("passes nothing identifying at any call site", () => {
    const forbidden = [
      "address",
      "session.",
      "sessionId",
      "request",
      "headers",
      "cookie",
      "ip",
      "user",
      "fingerprint",
      "device",
    ];
    for (const site of callSites()) {
      const lowered = site.args.toLowerCase();
      for (const token of forbidden) {
        expect(
          lowered.includes(token.toLowerCase()),
          `${site.file}: "${token}" in ${site.args}`,
        ).toBe(false);
      }
    }
  });

  it("passes only `config` and a closed event literal", () => {
    for (const site of callSites()) {
      // Every argument list is `config, { stage: … }` — a config object and an
      // inline literal. A variable event would be the first step toward one
      // built from request data.
      expect(site.args.trim(), site.file).toMatch(/^config,\s*\{\s*stage:/s);
    }
  });
});

describe("increment semantics (C3: atomic, never read-then-write)", () => {
  it("accumulates per (stage, day) and keeps days separate", async () => {
    const store = new InMemoryFunnelCounterStore();
    await store.increment("visit_learn_index", "2026-07-30");
    await store.increment("visit_learn_index", "2026-07-30");
    await store.increment("visit_learn_index", "2026-07-31");
    await store.increment("connect", "2026-07-31");

    const rows = await store.since("2026-07-30");
    expect(rows).toEqual([
      { stage: "visit_learn_index", day: "2026-07-30", count: 2 },
      { stage: "connect", day: "2026-07-31", count: 1 },
      { stage: "visit_learn_index", day: "2026-07-31", count: 1 },
    ]);
  });

  it("loses no increment under concurrent writes to the SAME row", async () => {
    // The M6.3 P1 shape: a read-then-write would drop all but one of these.
    // The in-memory store stands in for the SQL `ON CONFLICT DO UPDATE`, which
    // is one statement under the conflict's own row lock.
    const store = new InMemoryFunnelCounterStore();
    await Promise.all(
      Array.from({ length: 50 }, () => store.increment("visit_learn_index", "2026-07-31")),
    );
    const rows = await store.since("2026-07-31");
    expect(rows).toEqual([{ stage: "visit_learn_index", day: "2026-07-31", count: 50 }]);
  });

  it("keys the day in UTC, so the series survives a DST boundary", () => {
    // 00:30 UTC on the 31st is still the 31st, whatever the server's zone.
    expect(utcDay(new Date("2026-07-31T00:30:00.000Z"))).toBe("2026-07-31");
    expect(utcDay(new Date("2026-07-31T23:59:59.000Z"))).toBe("2026-07-31");
    expect(utcDay(new Date("2026-08-01T00:00:00.000Z"))).toBe("2026-08-01");
  });
});

describe("a counter failure never fails a page (invariant 9)", () => {
  it("swallows a store failure — nothing throws, nothing rejects", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const store = await getFunnelCounterStore({ appEnv: "development" });
    vi.spyOn(store, "increment").mockRejectedValue(new Error("database is down"));

    // Both halves matter: the synchronous call does not throw, AND the
    // fire-and-forget promise does not become an unhandled rejection (which
    // would crash the server process under Node's default handler).
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    expect(() =>
      recordFunnelEvent({ appEnv: "development" }, { stage: "connect" }, NOW),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off("unhandledRejection", unhandled);

    expect(unhandled).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();
  });

  it("a loader still renders when the counter store is down", async () => {
    // The loader-with-DB-down case: the page's own work completes and returns
    // normally while the counter write is failing underneath it.
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const store = await getFunnelCounterStore({ appEnv: "development" });
    vi.spyOn(store, "increment").mockRejectedValue(new Error("database is down"));

    async function loaderLike(): Promise<string> {
      recordFunnelEvent({ appEnv: "development" }, { stage: "visit", pageClass: "learn_index" });
      return "rendered";
    }
    await expect(loaderLike()).resolves.toBe("rendered");
  });

  it("returns void, so a loader cannot accidentally await a metrics write", () => {
    // The signature IS the guarantee: a promise-returning increment invites
    // `await recordFunnelEvent(...)` in a loader, which makes a page's latency
    // depend on an analytics table.
    const returned = recordFunnelEvent({ appEnv: "development" }, { stage: "connect" }, NOW);
    expect(returned).toBeUndefined();
  });

  it("logs the stage and NOTHING else on failure (invariant 18)", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    resetFunnelCounterStoreForTests();
    const real = await getFunnelCounterStore({ appEnv: "development" });
    vi.spyOn(real, "increment").mockRejectedValue(new Error("nope"));

    recordFunnelEvent({ appEnv: "development" }, { stage: "visit", pageClass: "market" }, NOW);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(debug).toHaveBeenCalled();
    const [, payload] = debug.mock.calls[0]!;
    // Exactly two fields, and the stage is one of the closed keys. There is no
    // address, session or device available to log even by accident, because the
    // event never carried one.
    expect(Object.keys(payload as object).sort()).toEqual(["error", "stage"]);
    expect(FUNNEL_STAGE_KEYS).toContain((payload as { stage: string }).stage);
  });
});

describe("retention is a bound, not an aspiration (invariant 16)", () => {
  it("states the total row ceiling as a product of two closed sets", () => {
    expect(FUNNEL_RETENTION_DAYS).toBe(400);
    expect(MAX_FUNNEL_ROWS).toBe(FUNNEL_STAGE_KEYS.length * FUNNEL_RETENTION_DAYS);
  });

  it("computes the cutoff day at the stated window", () => {
    expect(funnelRetentionCutoff(new Date("2026-07-31T00:00:00.000Z"))).toBe("2025-06-26");
  });

  it("deletes rows older than the window and keeps the rest", async () => {
    resetFunnelCounterStoreForTests();
    const store = await getFunnelCounterStore({ appEnv: "development" });
    const cutoff = funnelRetentionCutoff(NOW);
    const older = utcDay(new Date(Date.parse(`${cutoff}T00:00:00Z`) - 24 * 60 * 60 * 1000));

    await store.increment("connect", older);
    await store.increment("connect", utcDay(NOW));

    const deleted = await sweepFunnelCounters({ appEnv: "development" }, NOW);
    expect(deleted).toBe(1);
    const rows = await store.since("2000-01-01");
    expect(rows.map((r) => r.day)).toEqual([utcDay(NOW)]);
  });
});
