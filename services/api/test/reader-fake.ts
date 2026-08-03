// In-memory IndexedReader fake, built FROM FACTS through the real derive.ts
// mappers — so the populated contract tests exercise the same derivation code
// the Prisma reader uses (only the SELECTs are faked, not the math). Ordering
// and pagination mirror reader-prisma.ts semantics: epochs newest-first by
// epochIndex, incidents newest-first by openedAt, skip/take slicing.

import type { AlertArrearsFact } from "@nvhash/api-types";
import type {
  AdminEpochFacts,
  HolderLifecycleFacts,
  ValidatorEpochAggregateFacts,
} from "../src/admin-derive.ts";
import type { IndexedReader } from "../src/reader.ts";
import type { EpochStepFact } from "../src/portfolio-metrics.ts";
import {
  derivePayoutStats,
  derivePortfolio,
  deriveHeads,
  deriveMetrics,
  deriveValidatorsPayload,
  isActiveRedemption,
  navPriceNhash,
  payoutDurationSeconds,
  PAYOUT_STATS_WINDOW_DAYS,
  toAlertArrearsFact,
  toAlertIncidentFact,
  toAlertRedemptionFact,
  toBridgedSupplyRow,
  toEpochRow,
  toIncidentRow,
  toMarketSample,
  toTransactionRow,
  type AdminIncidentFacts,
  type AlertIncidentFacts,
  type BridgedSupplyFacts,
  type GovPolicyFacts,
  type GovProposalFacts,
  type GovVoteFacts,
  type EpochSnapshotFacts,
  type IncidentFacts,
  type MarketSampleFacts,
  type MetricsFacts,
  type OperatorEpochFacts,
  type OperatorPaymentFacts,
  type OperatorPaymentTotalFacts,
  type OperatorRegistryFacts,
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
  /** Fixed "now" for the payout-stats recent-window filter (deterministic). */
  readonly payoutNow?: Date | undefined;
  /**
   * Internal alert-facts fixtures. `alertIncidents` backs the internal
   * incidents projection (id + dedupeKey), distinct from `incidents` (the
   * public `/incidents` projection, which carries neither). Arrears derives
   * from `registry` (needs `operator`) + `validatorEpochs`, mirroring the
   * Prisma reader's join; redemptions reuse the `redemptions` fixtures.
   */
  readonly alertIncidents?: readonly AlertIncidentFacts[] | undefined;
  /**
   * Operator fixtures. `operatorRegistry` carries the address→valoper
   * mapping (`operator` is required here, unlike the public `registry`);
   * `operatorEpochs` is the FULL per-epoch economics the operator surface
   * serves, distinct from the narrow public `validatorEpochs`.
   */
  readonly operatorRegistry?: readonly OperatorRegistryFacts[] | undefined;
  readonly operatorEpochs?: readonly OperatorEpochFacts[] | undefined;
  readonly operatorPayments?: readonly OperatorPaymentFacts[] | undefined;
  /**
   * Governance fixtures. `govIndexedFromHeight` is separate from the
   * proposals on purpose: the honest-empty case is "rows present, coverage
   * window unknown", and a fake that derived the field from the rows could not
   * express it.
   */
  readonly govProposals?: readonly GovProposalFacts[] | undefined;
  readonly govVotes?: readonly GovVoteFacts[] | undefined;
  readonly govPolicies?: readonly GovPolicyFacts[] | undefined;
  readonly govIndexedFromHeight?: number | null | undefined;
  /**
   * §8.8 admin fixtures. `adminEpochs` is the settlement series with the extra
   * columns the admin panels need (`endHeight`, `netDeposits`,
   * `validatorsPurged`) — distinct from `epochs`, which is the narrower public
   * `/epochs` projection.
   *
   * `holderLifecycles` and `holderPositions` are seeded DIRECTLY rather than
   * folded out of `transactions`: the Prisma reader computes them in SQL with a
   * window function, so a fake that re-derived them here would be testing a
   * second implementation of the fold instead of the panels that consume it.
   * Neither carries an address — the production fact shapes do not either.
   */
  readonly adminEpochs?: readonly AdminEpochFacts[] | undefined;
  readonly holderLifecycles?: readonly HolderLifecycleFacts[] | undefined;
  /** EVERY positive holder position, in any order. Seed more than
   * `CONCENTRATION_BAND_DEPTH` of them to exercise the banded-transfer path. */
  readonly holderPositions?: readonly bigint[] | undefined;
  /** One first-`swap_in` timestamp per depositor, over all history. The
   * windowed funnel terminal is a filter over these; `undefined` is the
   * unknown answer (null on the wire), distinct from a seeded empty list. */
  readonly firstDepositTimes?: readonly Date[] | undefined;
  readonly validatorEpochAggregates?: readonly ValidatorEpochAggregateFacts[] | undefined;
  readonly validatorRegistryCounts?: { enrolledNow: number; churnedTotal: number } | undefined;
  readonly redemptionLatencies?: readonly number[] | undefined;
  readonly adminIncidents?: readonly AdminIncidentFacts[] | undefined;
}

function page<T>(rows: readonly T[], p: Pagination): T[] {
  return rows.slice(p.offset, p.offset + p.limit);
}

export function fakeReader(facts: FakeFacts): IndexedReader {
  /** One address's history ascending by (height, msgIndex) — production order. */
  const ascTransactions = (address: string): TransactionFacts[] =>
    [...(facts.transactions ?? [])]
      .filter((t) => t.address === address)
      .sort((a, b) =>
        a.height === b.height ? a.msgIndex - b.msgIndex : a.height < b.height ? -1 : 1,
      );

  return {
    heads: () =>
      Promise.resolve(deriveHeads(facts.reconcilerRun ?? null, facts.maxCheckpointHeight ?? null)),
    programMetrics: () =>
      Promise.resolve(
        deriveMetrics(
          facts.metrics ?? {
            indexed: false,
            participantCount: 0,
            firstActivityAt: null,
            epochCount: 0,
          },
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
        // Sort by chain ascending to MATCH the Prisma reader's ordering
        //: Map insertion order is first temporal appearance,
        // which only coincidentally agrees with the real reader's
        // `chain: "asc"` — the fake must not diverge from production order.
        bridged_supply: [...latestByChain.values()]
          .sort((a, b) => (a.chain < b.chain ? -1 : 1))
          .map(toBridgedSupplyRow),
      });
    },
    payoutStats: () => {
      // Mirror the Prisma reader: recent terminal cohort → durations →
      // derivePayoutStats with the completed-epoch count as the cold-start
      // gate. The fake windows by a fixed `now` if provided (deterministic).
      const now = facts.payoutNow ?? new Date();
      const cutoff = new Date(now.getTime() - PAYOUT_STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const durations: number[] = [];
      for (const r of facts.redemptions ?? []) {
        if (r.status !== "matured" && r.status !== "expedited") continue;
        const paid = r.expeditedAt ?? r.maturedAt ?? null;
        if (paid === null || paid < cutoff) continue;
        const d = payoutDurationSeconds(r);
        if (d !== null) durations.push(d);
      }
      return Promise.resolve(derivePayoutStats(durations, facts.epochs?.length ?? 0));
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
            .sort((a, b) =>
              a.height === b.height ? b.msgIndex - a.msgIndex : a.height < b.height ? 1 : -1,
            ),
          p,
        ).map(toTransactionRow),
      ),
    transactionsAscFor: (address) => Promise.resolve(ascTransactions(address)),
    // Chunked like the Prisma reader so a consumer that only handles a
    // single-chunk stream cannot pass here and fail in production.
    async *transactionsAscStream(address) {
      const rows = ascTransactions(address);
      for (let i = 0; i < rows.length; i += 1000) yield rows.slice(i, i + 1000);
    },
    listEpochsAsc: () =>
      Promise.resolve(
        [...(facts.epochs ?? [])]
          .sort((a, b) => (a.epochIndex < b.epochIndex ? -1 : 1))
          .map(
            (e): EpochStepFact => ({
              epochIndex: e.epochIndex,
              endedAtSeconds: e.endedAtSeconds,
              tvvAfter: e.tvvAfter,
              totalShares: e.totalShares,
              netAprBps: e.netAprBps,
              endHeight: e.endHeight ?? e.epochIndex,
            }),
          ),
      ),
    // --- internal alert-facts (mirror reader-prisma.ts semantics) ------
    redemptionsChangedSince: (sinceHeight, afterId, limit) =>
      Promise.resolve(
        [...(facts.redemptions ?? [])]
          .filter(
            (r) =>
              r.lastHeight > BigInt(sinceHeight) ||
              (r.lastHeight === BigInt(sinceHeight) && r.requestId > afterId),
          )
          .sort((a, b) =>
            a.lastHeight === b.lastHeight
              ? a.requestId < b.requestId
                ? -1
                : 1
              : a.lastHeight < b.lastHeight
                ? -1
                : 1,
          )
          .slice(0, limit)
          .map(toAlertRedemptionFact),
      ),
    incidentsSince: (sinceId, limit) =>
      Promise.resolve(
        [...(facts.alertIncidents ?? [])]
          .filter((i) => i.id > BigInt(sinceId))
          .sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1))
          .slice(0, limit)
          .map(toAlertIncidentFact),
      ),
    latestArrears: () => {
      const epochs = facts.validatorEpochs ?? [];
      if (epochs.length === 0) return Promise.resolve([]);
      let maxEpoch = epochs[0]!.epochIndex;
      for (const e of epochs) if (e.epochIndex > maxEpoch) maxEpoch = e.epochIndex;
      // Active registry rows carry the operator to alert (unregistered → excluded).
      const operatorByValoper = new Map<string, string>();
      for (const r of facts.registry ?? []) {
        if (r.unregisteredAt === null && r.operator !== undefined) {
          operatorByValoper.set(r.valoper, r.operator);
        }
      }
      const out: AlertArrearsFact[] = [];
      for (const e of [...epochs].sort((a, b) => (a.valoper < b.valoper ? -1 : 1))) {
        if (e.epochIndex !== maxEpoch) continue;
        if (e.commissionDue <= 0n) continue;
        const operator = operatorByValoper.get(e.valoper);
        if (operator === undefined) continue; // unregistered → excluded
        out.push(
          toAlertArrearsFact({
            valoper: e.valoper,
            operator,
            epochIndex: e.epochIndex,
            commissionDue: e.commissionDue,
          }),
        );
      }
      return Promise.resolve(out);
    },
    // --- operator surface (mirror reader-prisma.ts semantics) ----------
    operatorValopers: (address) =>
      Promise.resolve(
        [...(facts.operatorRegistry ?? [])]
          .filter((r) => r.operator === address)
          .sort((a, b) =>
            a.moniker === b.moniker
              ? a.valoper < b.valoper
                ? -1
                : 1
              : a.moniker < b.moniker
                ? -1
                : 1,
          ),
      ),
    latestOperatorEpochs: (valopers) => {
      const wanted = new Set(valopers);
      const latest = new Map<string, OperatorEpochFacts>();
      for (const row of [...(facts.operatorEpochs ?? [])]
        .filter((e) => wanted.has(e.valoper))
        .sort((a, b) => (a.epochIndex < b.epochIndex ? -1 : 1))) {
        latest.set(row.valoper, row); // ascending walk: last write = latest
      }
      return Promise.resolve([...latest.values()]);
    },
    validatorEpochsFor: (valoper, p) =>
      Promise.resolve(
        page(
          [...(facts.operatorEpochs ?? [])]
            .filter((e) => e.valoper === valoper)
            .sort((a, b) => (a.epochIndex < b.epochIndex ? 1 : -1)),
          p,
        ),
      ),
    operatorPaymentTotalsFor: (valopers) => {
      const wanted = new Set(valopers);
      const acc = new Map<string, { commission: bigint; tip: bigint; count: number }>();
      for (const p of facts.operatorPayments ?? []) {
        if (!wanted.has(p.valoper)) continue;
        const cur = acc.get(p.valoper) ?? { commission: 0n, tip: 0n, count: 0 };
        if (p.paymentType === "commission") cur.commission += p.amount;
        else cur.tip += p.amount;
        cur.count += 1;
        acc.set(p.valoper, cur);
      }
      const out: OperatorPaymentTotalFacts[] = [...acc.entries()].map(([valoper, v]) => ({
        valoper,
        commissionPaidTotal: v.commission,
        tipPaidTotal: v.tip,
        paymentCount: v.count,
      }));
      return Promise.resolve(out);
    },
    operatorPaymentsFor: (valoper, p) =>
      Promise.resolve(
        page(
          [...(facts.operatorPayments ?? [])]
            .filter((r) => r.valoper === valoper)
            .sort((a, b) =>
              a.height === b.height ? b.msgIndex - a.msgIndex : a.height < b.height ? 1 : -1,
            ),
          p,
        ),
      ),
    // Chunked like the Prisma reader (CHUNK rows per yield), so a consumer that
    // only works for a single-chunk stream cannot pass here and fail in
    // production. Order mirrors production exactly: (height, msgIndex) asc.
    async *operatorPaymentsAscStream(valoper) {
      const CHUNK = 1000;
      const rows = [...(facts.operatorPayments ?? [])]
        .filter((r) => r.valoper === valoper)
        .sort((a, b) =>
          a.height === b.height ? a.msgIndex - b.msgIndex : a.height < b.height ? -1 : 1,
        );
      for (let i = 0; i < rows.length; i += CHUNK) yield rows.slice(i, i + CHUNK);
    },
    // Governance. The fake mirrors the real reader's HONESTY contract, not
    // merely its signature: `indexedFromHeight` stays null unless seeded (never 0,
    // which would claim coverage from genesis), and an unknown proposal id resolves
    // to null so the route's 404 path is exercised rather than an empty 200.
    listGovProposals: (page, filter) => {
      const all = (facts.govProposals ?? []).filter(
        (p) =>
          (filter.policy === undefined || p.groupPolicyAddress === filter.policy) &&
          (filter.status === undefined || p.status.toUpperCase() === filter.status.toUpperCase()),
      );
      // Newest first by id, matching reader-prisma: x/group ids are monotonic
      // chain-global, so id order IS submission order.
      const sorted = [...all].sort((a, b) => (a.proposalId < b.proposalId ? 1 : -1));
      return Promise.resolve({
        proposals: sorted.slice(page.offset, page.offset + page.limit),
        indexedFromHeight: facts.govIndexedFromHeight ?? null,
      });
    },
    govProposal: (proposalId) => {
      const proposal = (facts.govProposals ?? []).find((p) => p.proposalId === proposalId);
      if (proposal === undefined) return Promise.resolve(null);
      return Promise.resolve({
        proposal,
        votes: [...(facts.govVotes ?? [])]
          .filter((v) => v.proposalId === proposalId)
          .sort((a, b) =>
            a.submitTime.getTime() === b.submitTime.getTime()
              ? a.voter.localeCompare(b.voter)
              : a.submitTime.getTime() - b.submitTime.getTime(),
          ),
      });
    },
    listGovPolicies: () => Promise.resolve([...(facts.govPolicies ?? [])]),
    epochBoundariesAsc: () =>
      Promise.resolve(
        [...(facts.epochs ?? [])]
          .map((e) => ({ epochIndex: e.epochIndex, endHeight: e.endHeight ?? e.epochIndex }))
          .sort((a, b) => (a.endHeight < b.endHeight ? -1 : 1)),
      ),

    // --- §8.8 admin analytics ---------------------------------------------
    // Ordering mirrors reader-prisma.ts: epoch-keyed series ASCENDING (so a
    // truncated series drops the newest, not the oldest), positions
    // DESCENDING, incidents newest-first.
    adminEpochsAsc: (limit) =>
      Promise.resolve(
        [...(facts.adminEpochs ?? [])]
          .sort((a, b) => (a.epochIndex < b.epochIndex ? -1 : 1))
          .slice(0, limit),
      ),
    depositorCount: () =>
      Promise.resolve(
        // Null when nothing seeded it — the dataless answer, distinct from a
        // seeded zero, exactly as the Prisma reader distinguishes them. Either
        // holder fixture certifies the count: both enumerate the same set (one
        // depositor per entry), so a case that seeds only first-deposit times
        // still gets a real all-time figure to contrast the window against.
        facts.holderLifecycles?.length ?? facts.firstDepositTimes?.length ?? null,
      ),
    // ASC by first-deposit height then capped, mirroring the SQL: a fake that
    // ignored the limit could not exercise `holders_truncated`.
    holderLifecycles: (limit) =>
      Promise.resolve(
        [...(facts.holderLifecycles ?? [])]
          .sort((a, b) => (a.firstDepositHeight < b.firstDepositHeight ? -1 : 1))
          .slice(0, limit),
      ),
    holderPositions: (bandDepth) => {
      // Mirrors the SQL exactly: the BAND is sliced, the aggregates are not.
      // A fake that derived the count and total from the sliced list would
      // reproduce the defect it exists to catch and pass either way.
      const all = [...(facts.holderPositions ?? [])].sort((a, b) => (a > b ? -1 : 1));
      return Promise.resolve({
        topDesc: all.slice(0, bandDepth),
        holderCount: all.length,
        totalPosition: all.reduce((sum, value) => sum + value, 0n),
      });
    },
    firstDepositorsSince: (since) => {
      // Same rule as the SQL: first-deposit time over ALL history, then
      // filtered — never filtered then min'd.
      if (facts.firstDepositTimes === undefined) return Promise.resolve(null);
      return Promise.resolve(facts.firstDepositTimes.filter((at) => at >= since).length);
    },
    redemptionMix: () => {
      const mix = { enqueued: 0, expedited: 0, matured: 0, refunded: 0 };
      for (const r of facts.redemptions ?? []) mix[r.status] += 1;
      return Promise.resolve(mix);
    },
    validatorEpochAggregates: (limit) =>
      Promise.resolve(
        [...(facts.validatorEpochAggregates ?? [])]
          .sort((a, b) => (a.epochIndex < b.epochIndex ? -1 : 1))
          .slice(0, limit),
      ),
    validatorRegistryCounts: () =>
      Promise.resolve(
        facts.validatorRegistryCounts ?? {
          enrolledNow: (facts.registry ?? []).filter((r) => r.unregisteredAt === null).length,
          churnedTotal: (facts.registry ?? []).filter((r) => r.unregisteredAt !== null).length,
        },
      ),
    // Capped like the SQL, and the flag is judged on the ROWS taken — before
    // the null filter — exactly as the Prisma reader does. A fake that
    // measured truncation on the filtered array would agree with a caller that
    // made the same mistake, which is the bug this shape exists to prevent.
    redemptionLatencySeconds: (limit) => {
      if (facts.redemptionLatencies !== undefined) {
        const taken = facts.redemptionLatencies.slice(0, limit);
        return Promise.resolve({ seconds: [...taken], truncated: taken.length >= limit });
      }
      // Derived through the SAME `payoutDurationSeconds` the Prisma reader
      // uses, over PAID-OUT requests only (a refund never paid out, so it
      // yields no duration and is not selected), and NEWEST FIRST like the SQL
      // — so a capped fake keeps the same rows the database would, and a test
      // cannot pass here while failing against Postgres.
      const rows = (facts.redemptions ?? [])
        .filter((r) => r.status === "matured" || r.status === "expedited")
        .sort((a, b) =>
          a.lastHeight === b.lastHeight
            ? b.requestId.localeCompare(a.requestId)
            : a.lastHeight < b.lastHeight
              ? 1
              : -1,
        )
        .slice(0, limit);
      return Promise.resolve({
        seconds: rows.map(payoutDurationSeconds).filter((s): s is number => s !== null),
        truncated: rows.length >= limit,
      });
    },
    adminIncidents: (p) =>
      Promise.resolve(
        page(
          [...(facts.adminIncidents ?? [])].sort((a, b) =>
            a.openedAt.getTime() === b.openedAt.getTime()
              ? Number(b.id - a.id)
              : b.openedAt.getTime() - a.openedAt.getTime(),
          ),
          p,
        ),
      ),
  };
}
