// In-memory IndexedReader fake, built FROM FACTS through the real derive.ts
// mappers — so the populated contract tests exercise the same derivation code
// the Prisma reader uses (only the SELECTs are faked, not the math). Ordering
// and pagination mirror reader-prisma.ts semantics: epochs newest-first by
// epochIndex, incidents newest-first by openedAt, skip/take slicing.

import type { IndexedReader } from "../src/reader.ts";
import {
  deriveHeads,
  deriveMetrics,
  deriveValidatorsPayload,
  toEpochRow,
  toIncidentRow,
  type EpochSnapshotFacts,
  type IncidentFacts,
  type MetricsFacts,
  type ValidatorEpochFacts,
  type ValidatorRegistryFacts,
} from "../src/derive.ts";
import type { Pagination } from "../src/query.ts";

export interface FakeFacts {
  readonly reconcilerRun?: { chainHeight: bigint; indexedHeight: bigint } | undefined;
  readonly maxCheckpointHeight?: bigint | undefined;
  readonly metrics?: MetricsFacts | undefined;
  readonly epochs?: readonly EpochSnapshotFacts[] | undefined;
  readonly incidents?: readonly IncidentFacts[] | undefined;
  readonly registry?: readonly ValidatorRegistryFacts[] | undefined;
  readonly validatorEpochs?: readonly ValidatorEpochFacts[] | undefined;
}

function page<T>(rows: readonly T[], p: Pagination): T[] {
  return rows.slice(p.offset, p.offset + p.limit);
}

export function fakeReader(facts: FakeFacts): IndexedReader {
  return {
    heads: () =>
      Promise.resolve(
        deriveHeads(facts.reconcilerRun ?? null, facts.maxCheckpointHeight ?? null),
      ),
    programMetrics: () =>
      Promise.resolve(
        deriveMetrics(
          facts.metrics ?? { indexed: false, participantCount: 0, firstActivityAt: null, epochCount: 0 },
        ),
      ),
    listEpochs: (p) =>
      Promise.resolve(
        page(
          [...(facts.epochs ?? [])].sort((a, b) => (a.epochIndex < b.epochIndex ? 1 : -1)),
          p,
        ).map(toEpochRow),
      ),
    listIncidents: (p) =>
      Promise.resolve(
        page(
          [...(facts.incidents ?? [])].sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime()),
          p,
        ).map(toIncidentRow),
      ),
    listValidators: () => {
      const latest = new Map<string, ValidatorEpochFacts>();
      for (const row of [...(facts.validatorEpochs ?? [])].sort((a, b) =>
        a.epochIndex < b.epochIndex ? -1 : 1,
      )) {
        latest.set(row.valoper, row); // ascending walk: last write = latest epoch
      }
      return Promise.resolve(deriveValidatorsPayload(facts.registry ?? [], latest));
    },
  };
}
