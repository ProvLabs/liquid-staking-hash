// Property (Vitest + fast-check): applying per-epoch validator samples in one
// pass converges with resuming from any crank boundary, and re-applying is
// idempotent — including the stateful bit, enrollment/departure tracking
// (app-spec §9.2 / SECURITY.md idempotent replay). An in-memory store stands in
// for Postgres; the same pure `applySamples` runs against both.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applySamples,
  type EpochRow,
  type RegistryRow,
  type ValidatorStore,
} from "../../src/workers/validator-sampler/write.ts";
import type { CrankSample, SampledValidator } from "../../src/workers/validator-sampler/sample.ts";

interface RegistryState extends RegistryRow {
  unregisteredAt: Date | null;
}

class MemValidatorStore implements ValidatorStore {
  readonly registry = new Map<string, RegistryState>();
  readonly epochs = new Map<string, EpochRow>();

  async upsertRegistry(row: RegistryRow): Promise<void> {
    const existing = this.registry.get(row.valoper);
    if (!existing) {
      this.registry.set(row.valoper, { ...row, unregisteredAt: null });
    } else {
      // enrolledAt is set-once; re-appearance clears the unregistered mark.
      this.registry.set(row.valoper, {
        ...existing,
        operator: row.operator,
        moniker: row.moniker,
        unregisteredAt: null,
      });
    }
  }
  async upsertEpoch(row: EpochRow): Promise<void> {
    this.epochs.set(`${row.valoper}|${row.epochIndex}`, row);
  }
  async enrolledValopers(): Promise<string[]> {
    return [...this.registry.values()]
      .filter((r) => r.unregisteredAt === null)
      .map((r) => r.valoper);
  }
  async markUnregistered(valoper: string, at: Date): Promise<void> {
    const r = this.registry.get(valoper);
    if (r) this.registry.set(valoper, { ...r, unregisteredAt: at });
  }
}

function snapshot(store: MemValidatorStore): unknown {
  const registry = [...store.registry.values()]
    .map((r) => ({
      valoper: r.valoper,
      operator: r.operator,
      moniker: r.moniker,
      enrolledAt: r.enrolledAt.toISOString(),
      unregisteredAt: r.unregisteredAt === null ? null : r.unregisteredAt.toISOString(),
    }))
    .sort((a, b) => a.valoper.localeCompare(b.valoper));
  const epochs = [...store.epochs.values()]
    .map((e) => ({
      valoper: e.valoper,
      epochIndex: e.epochIndex.toString(),
      commissionAccrued: e.commissionAccrued.toString(),
      programDelegation: e.programDelegation.toString(),
      height: e.height.toString(),
      observedAt: e.observedAt.toISOString(),
    }))
    .sort((a, b) => `${a.valoper}|${a.epochIndex}`.localeCompare(`${b.valoper}|${b.epochIndex}`));
  return { registry, epochs };
}

const POOL = ["v0", "v1", "v2", "v3", "v4"];

function validator(valoper: string, epoch: number, idx: number): SampledValidator {
  return {
    valoper,
    operator: `op-${valoper}`,
    moniker: `mon-${valoper}`,
    enrolledAtSeconds: BigInt(1_700_000_000 + idx),
    uptimeBps: 10000,
    eligible: true,
    failingReasons: [],
    tip: 0n,
    commissionAccrued: BigInt(epoch * 100 + idx),
    commissionPaid: 0n,
    commissionDue: 0n,
    programDelegation: BigInt(idx * 10),
    jailedEvents: null,
  };
}

function build(epochs: { present: string[]; gap: number }[]): CrankSample[] {
  let h = 0n;
  return epochs.map((e, i) => {
    h += BigInt(e.gap);
    return {
      epochIndex: BigInt(i),
      height: h,
      observedAt: new Date(Number(h) * 1000),
      validators: e.present.map((valoper, idx) => validator(valoper, i, idx)),
    };
  });
}

const arb = fc.record({
  epochs: fc.array(fc.record({ present: fc.subarray(POOL), gap: fc.integer({ min: 1, max: 5 }) }), {
    maxLength: 10,
  }),
  splitFraction: fc.double({ min: 0, max: 1, noNaN: true }),
});

describe("validator-sampler convergence (incl. enrollment/departure)", () => {
  it("resume from any crank boundary == full backfill", async () => {
    await fc.assert(
      fc.asyncProperty(arb, async ({ epochs, splitFraction }) => {
        const samples = build(epochs);
        const k = Math.floor(splitFraction * samples.length);

        const full = new MemValidatorStore();
        await applySamples(full, samples);

        const split = new MemValidatorStore();
        await applySamples(split, samples.slice(0, k));
        await applySamples(split, samples.slice(k));

        expect(snapshot(split)).toEqual(snapshot(full));
      }),
      { numRuns: 300 },
    );
  });

  it("re-applying is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(arb, async ({ epochs }) => {
        const samples = build(epochs);
        const once = new MemValidatorStore();
        await applySamples(once, samples);
        const twice = new MemValidatorStore();
        await applySamples(twice, samples);
        await applySamples(twice, samples);
        expect(snapshot(twice)).toEqual(snapshot(once));
      }),
      { numRuns: 200 },
    );
  });
});
