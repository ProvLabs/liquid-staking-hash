// Deterministic synthetic load seeder (8.2 §2.2, commit A). Seeds the
// `indexed` schema as `indexer_writer` at the repo's two RECORDED measured
// depths (services/api/CLAUDE.md fold figures; api-design-notes cursor/planner
// figures) plus a CI-speed `smoke` profile, so every recorded number is
// reproducible by anyone rather than a one-off.
//
// Properties (each gated by test/seed-load.test.ts):
//   - deterministic by seed: the same seed produces byte-identical rows;
//   - synthetic addresses only (SECURITY.md data minimization): every bech32
//     is PRNG-derived, valid-shape for the API's zod schemas, and never
//     sourced from real chain history;
//   - devnet-only, fail closed: refuses any DATABASE_URL outside the dev-stack
//     shape unless SEED_LOAD_I_KNOW=1 (the drills-point-at-nothing-else rule
//     extended to seeding);
//   - truncate-first, so re-runs are idempotent (the standing pre-8.4a
//     reset-and-rebuild posture).
//
// Run: ./dev pnpm --filter @nvhash/indexer run seed:load -- --profile depth2 --seed 1

import { PrismaClient } from "../src/prisma.ts";

/** bech32 data charset (no b/i/o/1) — matches the API's boundary regexes. */
export const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** mulberry32: a tiny deterministic PRNG — quality is irrelevant, determinism
 * is the contract. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function charsetString(rng: () => number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += BECH32_CHARSET[Math.floor(rng() * BECH32_CHARSET.length)];
  }
  return out;
}

/** Synthetic account address: valid for `bech32AddressSchema`, never real
 * (shape-only validation upstream; these carry no checksum on purpose). */
export function syntheticAddress(rng: () => number): string {
  return `pb1${charsetString(rng, 38)}`;
}

/** Synthetic valoper: valid for `bech32ValoperSchema`. */
export function syntheticValoper(rng: () => number): string {
  return `pbvaloper1${charsetString(rng, 38)}`;
}

export interface LoadProfile {
  readonly name: string;
  readonly transactions: number;
  readonly holders: number;
  /** Index-0 holder's transaction count (the /portfolio/metrics worst case). */
  readonly heavyHolderTransactions: number;
  /** Index-0 valoper's payment count (the cursor + planner-flip condition). */
  readonly heavyValoperPayments: number;
  readonly otherPayments: number;
  readonly validators: number;
  readonly epochs: number;
  readonly redemptions: number;
  readonly proposals: number;
  readonly votesPerProposal: number;
}

/** The two RECORDED depths plus the CI-speed smoke profile. */
export const PROFILES: Record<"smoke" | "depth1" | "depth2", LoadProfile> = {
  smoke: {
    name: "smoke",
    transactions: 5_000,
    holders: 500,
    heavyHolderTransactions: 1_000,
    heavyValoperPayments: 3_000,
    otherPayments: 500,
    validators: 20,
    epochs: 6,
    redemptions: 400,
    proposals: 10,
    votesPerProposal: 3,
  },
  depth1: {
    name: "depth1",
    transactions: 400_000,
    holders: 40_000,
    heavyHolderTransactions: 100_000,
    heavyValoperPayments: 300_000,
    otherPayments: 5_000,
    validators: 100,
    epochs: 12,
    redemptions: 20_000,
    proposals: 50,
    votesPerProposal: 5,
  },
  depth2: {
    name: "depth2",
    transactions: 1_200_000,
    holders: 120_000,
    heavyHolderTransactions: 100_000,
    heavyValoperPayments: 300_000,
    otherPayments: 10_000,
    validators: 100,
    epochs: 12,
    redemptions: 60_000,
    proposals: 50,
    votesPerProposal: 5,
  },
};

/** Dev-stack URL shapes the seeder will write to without an override. */
const DEV_URL_PATTERN = /(postgres:5432\/nvhash|localhost:5433|127\.0\.0\.1:5433)/;

/**
 * Fail-closed devnet guard: throws unless the target matches the dev-stack
 * shape or SEED_LOAD_I_KNOW=1 explicitly overrides. A seeder pointed at a real
 * mirror would fabricate history under real addresses — the program lying
 * about state at scale.
 */
export function assertDevTarget(url: string | undefined, env: NodeJS.ProcessEnv): string {
  if (url === undefined || url === "") {
    throw new Error("seed-load: DATABASE_URL is not set");
  }
  if (env.SEED_LOAD_I_KNOW === "1") return url;
  if (!DEV_URL_PATTERN.test(url)) {
    throw new Error(
      `seed-load: DATABASE_URL does not look like the dev stack (${DEV_URL_PATTERN}); ` +
        "refusing to seed synthetic load data into it. Set SEED_LOAD_I_KNOW=1 only if you " +
        "are certain this is a disposable database (SECURITY.md devnet rule).",
    );
  }
  return url;
}

// Seeded time base: absolute (never the wall clock — determinism is the
// contract), spanning multiple epoch boundaries and a multi-month range so
// retention curves, epoch lag and the funnel window all have real spans
// (§4b C6). Terminal redemption timestamps sit in 2026-08 so the payout-stats
// recent window sees them when measured near authoring time; the window
// filter uses the wall clock at read time, which is the API's contract, not
// the seeder's.
const T0_SECONDS = Date.UTC(2026, 0, 1) / 1000; // 2026-01-01T00:00:00Z
const EPOCH_SECONDS = 30 * 24 * 60 * 60; // calendar-month-ish spacing

const dec = (n: number | bigint): string => n.toString();

export interface GeneratedTables {
  readonly profile: LoadProfile;
  readonly holders: string[];
  readonly valopers: string[];
  readonly operators: string[];
  transactionBatches(batchSize: number): Generator<Record<string, unknown>[]>;
  operatorPaymentBatches(batchSize: number): Generator<Record<string, unknown>[]>;
  epochSnapshots(): Record<string, unknown>[];
  validatorRegistry(): Record<string, unknown>[];
  validatorEpochs(): Record<string, unknown>[];
  redemptionRequests(): Record<string, unknown>[];
  govProposals(): Record<string, unknown>[];
  govVotes(): Record<string, unknown>[];
  reconcilerRuns(): Record<string, unknown>[];
}

/**
 * The pure, deterministic generator: everything derives from (profile, seed).
 * Batches are lazy so depth2's 1.5 M rows never sit in memory at once.
 */
export function createGenerator(profileName: keyof typeof PROFILES, seed: number): GeneratedTables {
  const profile = PROFILES[profileName];

  // Sub-streams get independent deterministic PRNGs so consuming one table's
  // generator never shifts another's output.
  const addrRng = mulberry32(seed * 7 + 1);
  const holders: string[] = [];
  for (let i = 0; i < profile.holders; i += 1) holders.push(syntheticAddress(addrRng));
  const valRng = mulberry32(seed * 7 + 2);
  const valopers: string[] = [];
  const operators: string[] = [];
  for (let i = 0; i < profile.validators; i += 1) {
    valopers.push(syntheticValoper(valRng));
    operators.push(syntheticAddress(valRng));
  }

  const txTimeStep = Math.max(
    1,
    Math.floor((profile.epochs * EPOCH_SECONDS) / profile.transactions),
  );

  function* transactionBatches(batchSize: number): Generator<Record<string, unknown>[]> {
    const rng = mulberry32(seed * 7 + 3);
    const kinds = ["swap_out_request", "redemption_payout", "transfer_in", "transfer_out"] as const;
    const seenFirst = new Set<number>();
    let batch: Record<string, unknown>[] = [];
    for (let i = 0; i < profile.transactions; i += 1) {
      // The heavy holder owns the first heavyHolderTransactions rows; the
      // rest round-robin the remaining holders.
      const holderIndex =
        i < profile.heavyHolderTransactions
          ? 0
          : 1 + ((i - profile.heavyHolderTransactions) % (profile.holders - 1));
      // A holder's FIRST event is always swap_in (the lifecycle fold's
      // first-deposit anchor); later events mix.
      let kind: string;
      if (seenFirst.has(holderIndex)) {
        kind = rng() < 0.6 ? "swap_in" : kinds[Math.floor(rng() * kinds.length)]!;
      } else {
        kind = "swap_in";
        seenFirst.add(holderIndex);
      }
      const seconds = T0_SECONDS + i * txTimeStep;
      batch.push({
        txhash: `LOAD${seed}X${i.toString(16).toUpperCase().padStart(12, "0")}`,
        msgIndex: 0,
        address: holders[holderIndex]!,
        kind,
        shares: dec(1_000_000 + Math.floor(rng() * 1_000_000)),
        nhash: dec(1_000 + Math.floor(rng() * 1_000)),
        navAtHeight: dec(10_000 + Math.floor(i / 10_000)),
        height: BigInt(1_000 + i),
        blockTime: new Date(seconds * 1000),
      });
      if (batch.length >= batchSize) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;
  }

  function* operatorPaymentBatches(batchSize: number): Generator<Record<string, unknown>[]> {
    const rng = mulberry32(seed * 7 + 4);
    const total = profile.heavyValoperPayments + profile.otherPayments;
    let batch: Record<string, unknown>[] = [];
    for (let i = 0; i < total; i += 1) {
      // Skew: the first heavyValoperPayments rows hit valoper[0] — the
      // recorded cursor-measurement and planner-flip condition.
      const valoperIndex =
        i < profile.heavyValoperPayments ? 0 : 1 + (i % Math.max(1, profile.validators - 1));
      const seconds = T0_SECONDS + i * 60;
      batch.push({
        txhash: `LOADPAY${seed}X${i.toString(16).toUpperCase().padStart(10, "0")}`,
        msgIndex: 0,
        ordinal: 0,
        valoper: valopers[valoperIndex]!,
        payer: operators[valoperIndex]!,
        paymentType: rng() < 0.8 ? "commission" : "tip",
        amount: dec(100 + Math.floor(rng() * 10_000)),
        epochIndex: null,
        height: BigInt(2_000 + i),
        occurredAt: new Date(seconds * 1000),
      });
      if (batch.length >= batchSize) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;
  }

  function epochSnapshots(): Record<string, unknown>[] {
    const rng = mulberry32(seed * 7 + 5);
    const rows: Record<string, unknown>[] = [];
    for (let e = 0; e < profile.epochs; e += 1) {
      const ended = T0_SECONDS + (e + 1) * EPOCH_SECONDS;
      const tvv = 300_000_000_000 + e * 5_000_000_000 + Math.floor(rng() * 1_000_000);
      rows.push({
        epochIndex: BigInt(e + 1),
        startedAtSeconds: BigInt(ended - EPOCH_SECONDS),
        endedAtSeconds: BigInt(ended),
        endHeight: BigInt(10_000 + e * 1_000),
        tvvBefore: dec(tvv - 1_000_000),
        tvvAfter: dec(tvv),
        totalShares: dec(300_000_000_000_000_000),
        rewardsClaimed: "0",
        commissionReceived: "0",
        tipsReceived: "0",
        rewardsDeposited: "0",
        settled: "0",
        writeDown: "0",
        deployed: "0",
        rebalanced: "0",
        unbondedForRedemptions: "0",
        aumFeeEstimate: "0",
        netDeposits: "0",
        redemptionsExpedited: Math.floor(rng() * 5),
        validatorsPurged: 0,
        eligibleCount: profile.validators,
        grossAprBps: 500,
        netAprBps: 430,
        txhash: `LOADEPOCH${e + 1}`,
        height: BigInt(10_000 + e * 1_000),
        observedAt: new Date(ended * 1000),
      });
    }
    return rows;
  }

  function validatorRegistry(): Record<string, unknown>[] {
    return valopers.map((valoper, i) => ({
      valoper,
      operator: operators[i]!,
      moniker: `load-val-${String(i).padStart(3, "0")}`,
      enrolledAt: new Date(T0_SECONDS * 1000),
      unregisteredAt: null,
    }));
  }

  function validatorEpochs(): Record<string, unknown>[] {
    const rng = mulberry32(seed * 7 + 6);
    const rows: Record<string, unknown>[] = [];
    for (let e = 0; e < profile.epochs; e += 1) {
      for (let v = 0; v < profile.validators; v += 1) {
        rows.push({
          valoper: valopers[v]!,
          epochIndex: BigInt(e + 1),
          uptimeBps: 9_000 + Math.floor(rng() * 1_000),
          eligible: true,
          failingReasons: [],
          tip: "0",
          commissionAccrued: dec(Math.floor(rng() * 1_000_000)),
          commissionPaid: "0",
          commissionDue: dec(Math.floor(rng() * 1_000)),
          programDelegation: dec(1_000_000_000 + Math.floor(rng() * 1_000_000)),
          height: BigInt(10_000 + e * 1_000),
          observedAt: new Date((T0_SECONDS + (e + 1) * EPOCH_SECONDS) * 1000),
        });
      }
    }
    return rows;
  }

  function redemptionRequests(): Record<string, unknown>[] {
    const rng = mulberry32(seed * 7 + 7);
    const statuses = ["enqueued", "expedited", "matured", "refunded"] as const;
    const rows: Record<string, unknown>[] = [];
    // Terminal timestamps sit near authoring time so payout stats populate.
    const terminalBase = Date.UTC(2026, 7, 1) / 1000; // 2026-08-01
    for (let i = 0; i < profile.redemptions; i += 1) {
      const owner = holders[i % profile.holders]!;
      const status = statuses[i % statuses.length]!;
      const enqueued = terminalBase - 25 * 24 * 60 * 60 - (i % 100) * 3_600;
      const terminal = terminalBase + (i % 12) * 24 * 60 * 60;
      rows.push({
        requestId: `LOADREQ${seed}X${i}`,
        owner,
        shares: dec(1_000_000 + Math.floor(rng() * 1_000_000)),
        estimates: null,
        status,
        enqueuedAt: new Date(enqueued * 1000),
        expeditedAt: status === "expedited" ? new Date(terminal * 1000) : null,
        maturedAt: status === "matured" ? new Date(terminal * 1000) : null,
        refundedAt: status === "refunded" ? new Date(terminal * 1000) : null,
        lastHeight: BigInt(5_000 + i),
        lastTxhash: `LOADRED${i}`,
      });
    }
    return rows;
  }

  function govProposals(): Record<string, unknown>[] {
    const rng = mulberry32(seed * 7 + 8);
    const rows: Record<string, unknown>[] = [];
    for (let p = 0; p < profile.proposals; p += 1) {
      const submit = T0_SECONDS + p * 7 * 24 * 60 * 60;
      rows.push({
        proposalId: BigInt(p + 1),
        groupPolicyAddress: `pb1${charsetString(rng, 38)}`,
        groupId: 1n,
        proposers: [holders[p % profile.holders]!],
        status: p % 3 === 0 ? "PROPOSAL_STATUS_SUBMITTED" : "PROPOSAL_STATUS_ACCEPTED",
        executorResult: "PROPOSAL_EXECUTOR_RESULT_NOT_RUN",
        metadata: null,
        title: `Synthetic load proposal ${p + 1}`,
        summary: `Deterministic synthetic proposal ${p + 1} for the 8.2 load suite.`,
        messages: [],
        submitTime: new Date(submit * 1000),
        votingPeriodEnd: new Date((submit + 3 * 24 * 60 * 60) * 1000),
        yesCount: dec(2),
        noCount: "0",
        abstainCount: "0",
        noWithVetoCount: "0",
        groupVersion: 1n,
        groupPolicyVersion: 1n,
        decisionPolicy: { "@type": "/cosmos.group.v1.ThresholdDecisionPolicy", threshold: "2" },
        observedHeight: BigInt(20_000 + p),
        observedAt: new Date((submit + 60) * 1000),
        height: BigInt(20_000 + p),
        txhash: `LOADGOV${p + 1}`,
        prunedAtHeight: null,
      });
    }
    return rows;
  }

  function govVotes(): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = [];
    for (let p = 0; p < profile.proposals; p += 1) {
      for (let v = 0; v < profile.votesPerProposal; v += 1) {
        const submit = T0_SECONDS + p * 7 * 24 * 60 * 60 + (v + 1) * 3_600;
        rows.push({
          proposalId: BigInt(p + 1),
          voter: holders[(p * profile.votesPerProposal + v) % profile.holders]!,
          option: v === 0 ? "VOTE_OPTION_NO" : "VOTE_OPTION_YES",
          metadata: null,
          submitTime: new Date(submit * 1000),
          weight: dec(1),
          height: BigInt(21_000 + p * 10 + v),
          txhash: `LOADVOTE${p + 1}X${v}`,
        });
      }
    }
    return rows;
  }

  function reconcilerRuns(): Record<string, unknown>[] {
    // One run row so envelope heights are non-null (populated-payload rule);
    // heights sit above every seeded row height.
    return [
      {
        ranAt: new Date(Date.UTC(2026, 7, 14)),
        chainHeight: BigInt(2_000_000),
        indexedHeight: BigInt(2_000_000),
        deltas: {},
        withinTolerance: true,
      },
    ];
  }

  return {
    profile,
    holders,
    valopers,
    operators,
    transactionBatches,
    operatorPaymentBatches,
    epochSnapshots,
    validatorRegistry,
    validatorEpochs,
    redemptionRequests,
    govProposals,
    govVotes,
    reconcilerRuns,
  };
}

function parseArgs(argv: string[]): { profile: keyof typeof PROFILES; seed: number } {
  let profile: keyof typeof PROFILES = "smoke";
  let seed = 1;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--profile") {
      const value = argv[i + 1];
      if (value !== "smoke" && value !== "depth1" && value !== "depth2") {
        throw new Error(`seed-load: unknown profile '${value}' (smoke|depth1|depth2)`);
      }
      profile = value;
      i += 1;
    } else if (argv[i] === "--seed") {
      seed = Number(argv[i + 1]);
      if (!Number.isSafeInteger(seed) || seed <= 0) {
        throw new Error("seed-load: --seed must be a positive integer");
      }
      i += 1;
    }
  }
  return { profile, seed };
}

async function main(): Promise<void> {
  const { profile, seed } = parseArgs(process.argv.slice(2));
  const url = assertDevTarget(process.env.DATABASE_URL, process.env);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const gen = createGenerator(profile, seed);
  const BATCH = 10_000;

  console.log(`seed-load: profile=${profile} seed=${seed} → ${url.replace(/:[^:@]+@/, ":***@")}`);

  // Truncate-first (idempotent re-runs): exactly the tables this seeder owns.
  await prisma.govVote.deleteMany();
  await prisma.govProposal.deleteMany();
  await prisma.reconcilerRun.deleteMany();
  await prisma.incident.deleteMany();
  await prisma.redemptionRequest.deleteMany();
  await prisma.operatorPayment.deleteMany();
  await prisma.validatorEpoch.deleteMany();
  await prisma.validatorRegistry.deleteMany();
  await prisma.epochSnapshot.deleteMany();
  await prisma.transaction.deleteMany();

  await prisma.epochSnapshot.createMany({ data: gen.epochSnapshots() as never });
  await prisma.validatorRegistry.createMany({ data: gen.validatorRegistry() as never });
  await prisma.validatorEpoch.createMany({ data: gen.validatorEpochs() as never });
  await prisma.redemptionRequest.createMany({ data: gen.redemptionRequests() as never });
  await prisma.govProposal.createMany({ data: gen.govProposals() as never });
  await prisma.govVote.createMany({ data: gen.govVotes() as never });
  await prisma.reconcilerRun.createMany({ data: gen.reconcilerRuns() as never });

  let txCount = 0;
  for (const batch of gen.transactionBatches(BATCH)) {
    await prisma.transaction.createMany({ data: batch as never });
    txCount += batch.length;
    if (txCount % 100_000 === 0) console.log(`  transactions: ${txCount}`);
  }
  let payCount = 0;
  for (const batch of gen.operatorPaymentBatches(BATCH)) {
    await prisma.operatorPayment.createMany({ data: batch as never });
    payCount += batch.length;
  }

  // Materialized holder lifecycles (8.2 commit D): the worker maintains this
  // per window in production; the seeder writes transactions directly, so it
  // runs the same full-table recompute-from-truth once here.
  await prisma.holderLifecycle.deleteMany();
  await prisma.$executeRaw`
    WITH deltas AS (
      SELECT "address", "height", "msgIndex",
             CASE "kind"
               WHEN 'swap_in'           THEN "shares"
               WHEN 'transfer_in'       THEN "shares"
               WHEN 'redemption_payout' THEN -"shares"
               WHEN 'transfer_out'      THEN -"shares"
               ELSE 0
             END AS delta
      FROM "indexed"."transactions"
    ),
    running AS (
      SELECT "address", "height",
             SUM(delta) OVER (
               PARTITION BY "address" ORDER BY "height", "msgIndex"
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS position
      FROM deltas
    ),
    first_deposit AS (
      SELECT "address", MIN("height") AS first_height
      FROM "indexed"."transactions"
      WHERE "kind" = 'swap_in'
      GROUP BY "address"
    ),
    exited AS (
      SELECT r."address", MIN(r."height") AS exit_height
      FROM running r
      JOIN first_deposit f ON f."address" = r."address"
      WHERE r."height" >= f.first_height AND r.position <= 0
      GROUP BY r."address"
    )
    INSERT INTO "indexed"."holder_lifecycles" ("address", "firstDepositHeight", "exitHeight")
    SELECT f."address", f.first_height, e.exit_height
    FROM first_deposit f
    LEFT JOIN exited e ON e."address" = f."address"`;

  console.log(
    `seed-load: done — ${txCount} transactions, ${payCount} operator payments, ` +
      `${gen.profile.holders} holders, ${gen.profile.validators} validators, ` +
      `${gen.profile.epochs} epochs, ${gen.profile.redemptions} redemptions`,
  );
  // The heavy identities the load scenarios target (export these for run.sh).
  console.log(`export HEAVY_ADDRESS=${gen.holders[0]}`);
  console.log(`export HEAVY_VALOPER=${gen.valopers[0]}`);
  console.log(`export HEAVY_OPERATOR=${gen.operators[0]}`);
  await prisma.$disconnect();
}

// Only run as a script, never on import (the tests import the pure pieces).
if (process.argv[1]?.endsWith("seed-load.ts")) {
  main().catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
}
