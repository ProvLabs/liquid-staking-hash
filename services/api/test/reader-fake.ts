// In-memory IndexedReader fake, built FROM FACTS through the real derive.ts
// mappers — so the populated contract tests exercise the same derivation code
// the Prisma reader uses (only the SELECTs are faked, not the math). Ordering
// and pagination mirror reader-prisma.ts semantics: epochs newest-first by
// epochIndex, incidents newest-first by openedAt, skip/take slicing.

import type { IndexedReader } from "../src/reader.ts";
import {
  derivePortfolio,
  deriveHeads,
  deriveMetrics,
  deriveValidatorsPayload,
  isActiveRedemption,
  navPriceNhash,
  toBridgedSupplyRow,
  toEpochRow,
  toIncidentRow,
  toMarketSample,
  toTransactionRow,
  type BridgedSupplyFacts,
  type EpochSnapshotFacts,
  type IncidentFacts,
  type MarketSampleFacts,
  type MetricsFacts,
  type RedemptionFacts,
  type TransactionFacts,
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
  readonly marketSamples?: readonly MarketSampleFacts[] | undefined;
  readonly bridgedSupply?: readonly BridgedSupplyFacts[] | undefined;
  readonly transactions?: readonly TransactionFacts[] | undefined;
  readonly redemptions?: readonly RedemptionFacts[] | undefined;
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
    latestMarket: () => {
      const samples = [...(facts.marketSamples ?? [])].sort(
        (a, b) => b.sampledAt.getTime() - a.sampledAt.getTime(),
      );
      const raw = samples[0];
      let sample = null;
      if (raw !== undefined) {
        // Mirror the Prisma reader's [R6] lookup: the last epoch settled at
        // or before the sample's time supplies the premium denominator.
        const sampledAtSeconds = BigInt(Math.floor(raw.sampledAt.getTime() / 1000));
        const navEpoch = [...(facts.epochs ?? [])]
          .filter((e) => e.endedAtSeconds <= sampledAtSeconds)
          .sort((a, b) => (a.epochIndex < b.epochIndex ? 1 : -1))[0];
        const nav =
          navEpoch === undefined ? null : navPriceNhash(navEpoch.tvvAfter, navEpoch.totalShares);
        sample = toMarketSample(raw, nav);
      }
      const latestByChain = new Map<string, BridgedSupplyFacts>();
      for (const row of [...(facts.bridgedSupply ?? [])].sort(
        (a, b) => a.sampledAt.getTime() - b.sampledAt.getTime(),
      )) {
        latestByChain.set(row.chain, row); // ascending walk: last write = latest
      }
      return Promise.resolve({
        sample,
        bridged_supply: [...latestByChain.values()].map(toBridgedSupplyRow),
      });
    },
    portfolioFor: (address) => {
      const mine = (facts.transactions ?? []).filter((t) => t.address === address);
      const first = [...mine].sort((a, b) => a.blockTime.getTime() - b.blockTime.getTime())[0];
      const active = (facts.redemptions ?? []).filter(
        (r) => r.owner === address && isActiveRedemption(r.status),
      );
      return Promise.resolve(
        derivePortfolio(
          address,
          first?.blockTime ?? null,
          mine.length,
          [...active].sort((a, b) => b.enqueuedAt.getTime() - a.enqueuedAt.getTime()),
        ),
      );
    },
    transactionsFor: (address, p) =>
      Promise.resolve(
        page(
          [...(facts.transactions ?? [])]
            .filter((t) => t.address === address)
            .sort((a, b) => (a.height === b.height ? b.msgIndex - a.msgIndex : a.height < b.height ? 1 : -1)),
          p,
        ).map(toTransactionRow),
      ),
  };
}
