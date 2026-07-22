// Unit (Postgres-free): the reconciler's pure core — delta computation, lag
// accounting, and `deriveActions` incident rules, including the honesty alarm
// (a corrupted indexed value → a reconciler_divergence to open). The end-to-end
// alarm against real Postgres is test/integration/reconciler-alarm.test.ts; the
// logic itself is fully exercised here without a database.

import { describe, expect, it } from "vitest";
import { computeDeltas } from "../../src/reconciler/deltas.ts";
import { computeLag } from "../../src/reconciler/lag.ts";
import { deriveActions, type IndexedPlane, type LivePlane } from "../../src/reconciler/incidents.ts";
import { TOLERANCES } from "../../src/reconciler/tolerances.ts";

const NOW = new Date("2026-07-21T00:00:00Z");
const live = (over: Partial<LivePlane> = {}): LivePlane => ({
  head: 1000n,
  snapshot: { epochIndex: 8n, totalShares: 1000n, tvvAfter: 500n },
  halted: false,
  ...over,
});
const indexed = (over: Partial<IndexedPlane> = {}): IndexedPlane => ({
  maxEpoch: 8n,
  chainEpochRow: { totalShares: 1000n, tvvAfter: 500n },
  checkpoints: [{ stream: "chain-events", cursorHeight: 1000n }],
  writeDownEpochs: [],
  refundedRequestIds: [],
  existingPointInTimeKeys: new Set<string>(),
  ...over,
});

const open = (a: ReturnType<typeof deriveActions>, kind: string) => a.open.find((o) => o.kind === kind);
const closing = (a: ReturnType<typeof deriveActions>, kind: string) => a.close.some((c) => c.kind === kind);

describe("computeDeltas", () => {
  const snap = { epochIndex: 8n, totalShares: 1000n, tvvAfter: 500n };

  it("is within tolerance when the indexed copy matches chain exactly", () => {
    const d = computeDeltas(snap, { totalShares: 1000n, tvvAfter: 500n }, 8n, TOLERANCES);
    expect(d).toMatchObject({ compared: true, withinTolerance: true, divergentMetrics: [] });
  });

  it("diverges when a copied value differs (exact-copy tolerance is 0)", () => {
    const d = computeDeltas(snap, { totalShares: 999n, tvvAfter: 500n }, 8n, TOLERANCES);
    expect(d.withinTolerance).toBe(false);
    expect(d.divergentMetrics).toEqual(["total_shares"]);
    expect(d.totalSharesDelta).toBe(-1n);
  });

  it("treats a not-yet-ingested epoch as lag, not divergence", () => {
    const d = computeDeltas(snap, null, 7n, TOLERANCES);
    expect(d).toMatchObject({ compared: false, withinTolerance: true, epochLag: 1n });
  });
});

describe("computeLag", () => {
  it("excludes meta: markers and flags lag over the threshold", () => {
    const r = computeLag(
      [
        { stream: "chain-events", cursorHeight: 800n },
        { stream: "meta:provenance", cursorHeight: 0n }, // excluded
      ],
      1000n,
      TOLERANCES,
    );
    expect(r.perStream.map((s) => s.stream)).toEqual(["chain-events"]);
    expect(r.maxLag).toBe(200n);
    expect(r.over).toBe(true); // 200 > 120
    expect(r.indexedHeight).toBe(800n);
  });

  it("is within tolerance when caught up", () => {
    expect(computeLag([{ stream: "chain-events", cursorHeight: 1000n }], 1000n, TOLERANCES).over).toBe(false);
  });

  it("reports indexedHeight 0 (not the head) on cold start with no worker streams", () => {
    // Only meta: markers exist → nothing is indexed; must NOT claim the head.
    const r = computeLag([{ stream: "meta:provenance", cursorHeight: 0n }], 1000n, TOLERANCES);
    expect(r.perStream).toEqual([]);
    expect(r.indexedHeight).toBe(0n);
    // Cold start is signalled by indexedHeight 0, not a DATA-DEGRADED incident.
    expect(r.over).toBe(false);
  });
});

describe("deriveActions", () => {
  it("opens reconciler_divergence when an indexed value is corrupt (the alarm)", () => {
    const actions = deriveActions(live(), indexed({ chainEpochRow: { totalShares: 999n, tvvAfter: 500n } }), TOLERANCES, NOW);
    const div = open(actions, "reconciler_divergence");
    expect(div).toMatchObject({ dedupeKey: "latest", severity: "critical", linkToRun: true });
    expect(actions.run.withinTolerance).toBe(false);
  });

  it("closes reconciler_divergence when the indexed copy matches", () => {
    const actions = deriveActions(live(), indexed(), TOLERANCES, NOW);
    expect(open(actions, "reconciler_divergence")).toBeUndefined();
    expect(closing(actions, "reconciler_divergence")).toBe(true);
    expect(actions.run.withinTolerance).toBe(true);
  });

  it("opens indexer_lag when a stream trails the head", () => {
    const actions = deriveActions(live(), indexed({ checkpoints: [{ stream: "chain-events", cursorHeight: 500n }] }), TOLERANCES, NOW);
    expect(open(actions, "indexer_lag")).toMatchObject({ severity: "warning" });
  });

  it("opens contract_halted when the contract is halted", () => {
    expect(open(deriveActions(live({ halted: true }), indexed(), TOLERANCES, NOW), "contract_halted")).toBeDefined();
    expect(closing(deriveActions(live(), indexed(), TOLERANCES, NOW), "contract_halted")).toBe(true);
  });

  it("opens point-in-time incidents for slash write-downs and refunds", () => {
    const actions = deriveActions(live(), indexed({ writeDownEpochs: [3n], refundedRequestIds: ["7"] }), TOLERANCES, NOW);
    expect(open(actions, "slash_write_down")).toMatchObject({ dedupeKey: "epoch:3" });
    expect(open(actions, "redemption_refund")).toMatchObject({ dedupeKey: "request:7" });
    // point-in-time kinds never appear as close actions
    expect(actions.close.some((c) => c.kind === "slash_write_down" || c.kind === "redemption_refund")).toBe(false);
  });

  it("does not re-open point-in-time incidents already recorded (bounded per-pass work)", () => {
    const actions = deriveActions(
      live(),
      indexed({
        writeDownEpochs: [3n, 4n],
        refundedRequestIds: ["7", "8"],
        // epoch:3 and request:7 already have incidents → only the new ones open.
        existingPointInTimeKeys: new Set(["slash_write_down epoch:3", "redemption_refund request:7"]),
      }),
      TOLERANCES,
      NOW,
    );
    const slash = actions.open.filter((o) => o.kind === "slash_write_down").map((o) => o.dedupeKey);
    const refund = actions.open.filter((o) => o.kind === "redemption_refund").map((o) => o.dedupeKey);
    expect(slash).toEqual(["epoch:4"]);
    expect(refund).toEqual(["request:8"]);
  });

  it("produces JSON-safe payloads (no bigint) so they can persist to JSONB", () => {
    const actions = deriveActions(live({ halted: true }), indexed({ writeDownEpochs: [3n] }), TOLERANCES, NOW);
    for (const o of actions.open) expect(() => JSON.stringify(o.payload)).not.toThrow();
    expect(() => JSON.stringify(actions.run.deltas)).not.toThrow();
  });
});
