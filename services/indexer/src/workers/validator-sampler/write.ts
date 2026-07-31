// Apply per-epoch validator samples to `validator_registry` + `validator_epochs`.
// Pure over an abstract `ValidatorStore` (Postgres via store.ts; in-memory in
// the replay property test). Samples MUST be applied in ascending crank order:
// enrollment is set-once, epoch rows upsert by (valoper, epochIndex), and a
// validator that has left the set is marked unregistered at the crank where it
// first disappears — all forward-deterministic, so full replay and resume
// converge (app-spec §9.2 / SECURITY.md).

import type { CrankSample, SampledValidator } from "./sample.ts";

export interface RegistryRow {
  valoper: string;
  operator: string;
  moniker: string;
  enrolledAt: Date;
}

export interface EpochRow {
  valoper: string;
  epochIndex: bigint;
  uptimeBps: number;
  eligible: boolean;
  failingReasons: string[];
  tip: bigint;
  commissionAccrued: bigint;
  commissionPaid: bigint;
  commissionDue: bigint;
  programDelegation: bigint;
  jailedEvents: unknown | null;
  height: bigint;
  observedAt: Date;
}

export interface ValidatorStore {
  /** create-if-absent (enrolledAt set-once) and clear any unregistered mark. */
  upsertRegistry(row: RegistryRow): Promise<void>;
  upsertEpoch(row: EpochRow): Promise<void>;
  /** valopers currently enrolled (unregisteredAt IS NULL). */
  enrolledValopers(): Promise<string[]>;
  markUnregistered(valoper: string, at: Date): Promise<void>;
}

function toRegistry(v: SampledValidator): RegistryRow {
  return {
    valoper: v.valoper,
    operator: v.operator,
    moniker: v.moniker,
    // enrolledAt is the contract's enrolled_at_seconds (deterministic, set-once).
    enrolledAt: new Date(Number(v.enrolledAtSeconds) * 1000),
  };
}

function toEpoch(v: SampledValidator, sample: CrankSample): EpochRow {
  return {
    valoper: v.valoper,
    epochIndex: sample.epochIndex,
    uptimeBps: v.uptimeBps,
    eligible: v.eligible,
    failingReasons: v.failingReasons,
    tip: v.tip,
    commissionAccrued: v.commissionAccrued,
    commissionPaid: v.commissionPaid,
    commissionDue: v.commissionDue,
    programDelegation: v.programDelegation,
    jailedEvents: v.jailedEvents,
    height: sample.height,
    observedAt: sample.observedAt,
  };
}

export async function applySamples(
  store: ValidatorStore,
  samples: readonly CrankSample[],
): Promise<void> {
  for (const sample of samples) {
    const present = new Set<string>();
    for (const v of sample.validators) {
      present.add(v.valoper);
      await store.upsertRegistry(toRegistry(v));
      await store.upsertEpoch(toEpoch(v, sample));
    }
    // Anyone enrolled but no longer in the set left the program at this crank.
    for (const valoper of await store.enrolledValopers()) {
      if (!present.has(valoper)) await store.markUnregistered(valoper, sample.observedAt);
    }
  }
}
