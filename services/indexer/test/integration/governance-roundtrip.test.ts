// gov_proposals / gov_votes round-trip — the database gate.
//
// The unit suites prove the DECODE (fixture shapes) and the CONVERGENCE (the pure
// writer over an in-memory store). This proves the third leg neither can: that
// the guards are real SQL.
//
// That distinction is the point. `governance-replay.test.ts` mirrors the
// conditional-update arm in TypeScript, so it can only ever prove the writer
// calls the store correctly — if the `ON CONFLICT … WHERE` clause were dropped
// from store.ts, that suite would still pass. §4b C3's requirement is a DATABASE
// constraint, not application logic, precisely because a backfill can run beside
// the live worker, and only Postgres can arbitrate that atomically. So the tests
// below drive the real `PrismaGovernanceStore`.
//
// What it holds:
//   * the monotonic `observedHeight` guard is enforced by the STATEMENT — a lower
//     observation loses even when it arrives last;
//   * a prune PRESERVES the row (never a delete) and stamps the first height;
//   * unbounded tally counts survive Decimal(39,0) at full precision — a weight
//     sum that went through a JS number could not;
//   * `proposers` round-trips as a real array, and the scalar `proposer` column
//     is gone;
//   * vote provenance is set-once: an empty state read cannot erase a txhash.
//
// Runs in the app-ci `db-grants` job (Postgres service) alongside the
// grant-boundary, reconciler-alarm and operator-payments gates.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/prisma.ts";
import { PrismaGovernanceStore } from "../../src/workers/governance/store.ts";
import type { ProposalUpsert } from "../../src/workers/governance/store.ts";
import type { Tally } from "../../src/workers/governance/events.ts";

const URL =
  process.env.DATABASE_URL ??
  process.env.ADMIN_DATABASE_URL ??
  "postgresql://nvhash:nvhash-dev@postgres:5432/nvhash?schema=indexed";

const prisma = new PrismaClient({ datasources: { db: { url: URL } } });

// A policy address distinctive enough that cleanup is surgical on a shared
// dev/CI database, and ids far above anything a devnet produces.
const POLICY = "tp1m71roundtrippolicy";
const ID_GUARD = 9_710_001n;
const ID_PRUNE = 9_710_002n;
const ID_VOTE = 9_710_003n;
const ID_BIG = 9_710_004n;

// 39 digits is the column's full precision. A weight sum that survives this
// cannot have passed through a double. x/group weights have no protocol ceiling,
// so this is a reachable shape, not a synthetic extreme.
const BIG = (10n ** 38n - 1n).toString();

const ZERO: Tally = { yes: "0", no: "0", abstain: "0", noWithVeto: "0" };

function proposal(
  over: Partial<ProposalUpsert> & { proposalId: bigint; observedHeight: bigint },
): ProposalUpsert {
  return {
    groupPolicyAddress: POLICY,
    groupId: 1n,
    proposers: ["tp1proposerone"],
    status: "SUBMITTED",
    executorResult: "NOT_RUN",
    metadata: null,
    title: "round-trip",
    summary: "",
    messages: [
      { "@type": "/cosmos.bank.v1beta1.MsgSend", amount: [{ denom: "nhash", amount: "1" }] },
    ],
    submitTime: new Date("2026-07-29T00:00:00Z"),
    votingPeriodEnd: new Date("2026-07-29T00:05:00Z"),
    tally: ZERO,
    groupVersion: 1n,
    groupPolicyVersion: 1n,
    decisionPolicy: { "@type": "/cosmos.group.v1.ThresholdDecisionPolicy", threshold: "2" },
    observedAt: new Date("2026-07-29T00:06:00Z"),
    ...over,
  };
}

/** Run a body inside a transaction, exactly as `runWindow` does for a window. */
function inTx<T>(fn: (store: PrismaGovernanceStore) => Promise<T>): Promise<T> {
  return prisma.$transaction((tx) => fn(new PrismaGovernanceStore(tx)));
}

async function cleanup(): Promise<void> {
  const ids = [ID_GUARD, ID_PRUNE, ID_VOTE, ID_BIG];
  await prisma.govVote.deleteMany({ where: { proposalId: { in: ids } } });
  await prisma.govProposal.deleteMany({ where: { proposalId: { in: ids } } });
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("gov_proposals round-trip (real Postgres)", () => {
  it("enforces the monotonic observedHeight guard IN THE STATEMENT", async () => {
    await inTx((s) =>
      s.upsertProposal(
        proposal({ proposalId: ID_GUARD, observedHeight: 500n, status: "REJECTED" }),
      ),
    );
    // The stale write arrives LAST. Application logic that read-compared-then-wrote
    // could interleave here; the `ON CONFLICT … WHERE` arm cannot.
    await inTx((s) =>
      s.upsertProposal(
        proposal({ proposalId: ID_GUARD, observedHeight: 100n, status: "SUBMITTED" }),
      ),
    );

    const row = await prisma.govProposal.findUniqueOrThrow({ where: { proposalId: ID_GUARD } });
    expect(row.status).toBe("REJECTED");
    expect(row.observedHeight).toBe(500n);
  });

  it("advances on a HIGHER observation", async () => {
    await inTx((s) =>
      s.upsertProposal(
        proposal({ proposalId: ID_GUARD, observedHeight: 900n, status: "ACCEPTED" }),
      ),
    );
    const row = await prisma.govProposal.findUniqueOrThrow({ where: { proposalId: ID_GUARD } });
    expect(row.status).toBe("ACCEPTED");
    expect(row.observedHeight).toBe(900n);
  });

  it("never regresses a known executorResult to the sweep's NOT_RUN default", async () => {
    await inTx((s) => s.setExecutorResult(ID_GUARD, "FAILURE", 890n));
    await inTx((s) =>
      s.upsertProposal(
        proposal({
          proposalId: ID_GUARD,
          observedHeight: 1000n,
          status: "ACCEPTED",
          executorResult: "NOT_RUN",
        }),
      ),
    );
    const row = await prisma.govProposal.findUniqueOrThrow({ where: { proposalId: ID_GUARD } });
    expect(row.executorResult).toBe("FAILURE");
  });

  it("round-trips proposers as an ARRAY, with the scalar column gone", async () => {
    await inTx((s) =>
      s.upsertProposal(
        proposal({
          proposalId: ID_BIG,
          observedHeight: 10n,
          proposers: ["tp1one", "tp1two"],
          tally: { yes: BIG, no: BIG, abstain: "0", noWithVeto: "1" },
        }),
      ),
    );
    const row = await prisma.govProposal.findUniqueOrThrow({ where: { proposalId: ID_BIG } });
    // x/group permits several proposers, which is why the scalar was a lie.
    expect(row.proposers).toEqual(["tp1one", "tp1two"]);
    expect("proposer" in row).toBe(false);
  });

  it("preserves unbounded tally counts at full Decimal(39,0) precision", async () => {
    const row = await prisma.govProposal.findUniqueOrThrow({ where: { proposalId: ID_BIG } });
    // Compared as STRINGS: reading these back through a JS number is the failure
    // this asserts against, so the assertion must not do it either.
    expect(row.yesCount.toFixed(0)).toBe(BIG);
    expect(row.noCount.toFixed(0)).toBe(BIG);
    expect(row.noWithVetoCount.toFixed(0)).toBe("1");
  });

  it("stores messages and decisionPolicy verbatim as JSON", async () => {
    const row = await prisma.govProposal.findUniqueOrThrow({ where: { proposalId: ID_BIG } });
    expect(row.messages).toEqual([
      { "@type": "/cosmos.bank.v1beta1.MsgSend", amount: [{ denom: "nhash", amount: "1" }] },
    ]);
    expect(row.decisionPolicy).toEqual({
      "@type": "/cosmos.group.v1.ThresholdDecisionPolicy",
      threshold: "2",
    });
  });

  it("leaves submit provenance NULL until the tx plane supplies it, then set-once", async () => {
    const before = await prisma.govProposal.findUniqueOrThrow({ where: { proposalId: ID_BIG } });
    // A proposal seen only by the sweep genuinely has no submit transaction; null
    // is honest where a fabricated height would not be.
    expect(before.txhash).toBeNull();
    expect(before.height).toBeNull();

    await inTx((s) => s.setSubmitProvenance(ID_BIG, "FIRSTHASH", 7n));
    await inTx((s) => s.setSubmitProvenance(ID_BIG, "SECONDHASH", 8n));
    const after = await prisma.govProposal.findUniqueOrThrow({ where: { proposalId: ID_BIG } });
    expect(after.txhash).toBe("FIRSTHASH");
    expect(after.height).toBe(7n);
  });
});

describe("prune PRESERVES the row — the mirror outlives chain state", () => {
  it("stamps prunedAtHeight and keeps every column", async () => {
    await inTx((s) => s.upsertProposal(proposal({ proposalId: ID_PRUNE, observedHeight: 200n })));
    await inTx((s) => s.setSubmitProvenance(ID_PRUNE, "PRUNEDTX", 190n));
    await inTx((s) =>
      s.setTerminalState(
        ID_PRUNE,
        "ACCEPTED",
        { yes: "2", no: "0", abstain: "1", noWithVeto: "0" },
        205n,
      ),
    );
    await inTx((s) => s.markPruned(ID_PRUNE, 205n));

    const row = await prisma.govProposal.findUniqueOrThrow({ where: { proposalId: ID_PRUNE } });
    // The chain no longer holds this proposal; the row is the durable record, so
    // nothing about it may have been deleted or nulled.
    expect(row.prunedAtHeight).toBe(205n);
    expect(row.status).toBe("ACCEPTED");
    expect(row.yesCount.toFixed(0)).toBe("2");
    expect(row.txhash).toBe("PRUNEDTX");
    expect(row.title).toBe("round-trip");
  });

  it("keeps the FIRST prune height on a repeat observation", async () => {
    await inTx((s) => s.markPruned(ID_PRUNE, 999n));
    const row = await prisma.govProposal.findUniqueOrThrow({ where: { proposalId: ID_PRUNE } });
    expect(row.prunedAtHeight).toBe(205n);
  });

  it("reports which proposal ids it holds — the orphan-vote guard's input", async () => {
    // Proposal recovery leans on this: votes insert unconditionally while proposals
    // upsert, so the writer must be able to ask what exists before storing a vote
    // whose proposal could not be recovered.
    const known = await inTx((s) => s.existingProposalIds([ID_GUARD, ID_PRUNE, 9_999_999n]));
    expect(known.has(ID_GUARD.toString())).toBe(true);
    // A PRUNED proposal is still HELD — the row is the durable record — so its
    // votes are legitimate and must not be refused.
    expect(known.has(ID_PRUNE.toString())).toBe(true);
    expect(known.has("9999999")).toBe(false);
    expect(await inTx((s) => s.existingProposalIds([]))).toEqual(new Set());
  });

  it("excludes pruned rows from the absence-diff candidate set", async () => {
    // `storedIdsForPolicies` feeds the prune diff. A row already stamped must not
    // come back, or every window would re-stamp it and the log would never quiet.
    const ids = await inTx((s) => s.storedIdsForPolicies([POLICY]));
    expect(ids).not.toContain(ID_PRUNE);
    expect(ids).toContain(ID_GUARD);
  });
});

describe("gov_votes round-trip", () => {
  it("keeps tx provenance when a later state-plane read has none", async () => {
    await inTx((s) => s.upsertProposal(proposal({ proposalId: ID_VOTE, observedHeight: 300n })));
    await inTx((s) =>
      s.upsertVote({
        proposalId: ID_VOTE,
        voter: "tp1votera",
        option: "YES",
        metadata: "rationale",
        weight: null,
        submitTime: new Date("2026-07-29T00:01:00Z"),
        height: 295n,
        txhash: "VOTETX",
      }),
    );
    // The state plane can supply a weight but never a txhash. COALESCE is what
    // keeps the two from erasing each other.
    await inTx((s) =>
      s.upsertVote({
        proposalId: ID_VOTE,
        voter: "tp1votera",
        option: "YES",
        metadata: null,
        weight: "3",
        submitTime: new Date("2026-07-29T00:01:00Z"),
        height: null,
        txhash: null,
      }),
    );

    const row = await prisma.govVote.findUniqueOrThrow({
      where: { proposalId_voter: { proposalId: ID_VOTE, voter: "tp1votera" } },
    });
    expect(row.txhash).toBe("VOTETX");
    expect(row.height).toBe(295n);
    expect(row.weight?.toFixed(0)).toBe("3");
    expect(row.metadata).toBe("rationale");
  });

  it("keys on (proposalId, voter) — the key the drill MEASURED, not assumed", async () => {
    // The chain rejects a second vote from the same voter (drill phase 7d), so this
    // key is sound. Storage-level idempotency is what makes replay converge: a
    // re-applied window upserts rather than duplicating.
    await inTx((s) =>
      s.upsertVote({
        proposalId: ID_VOTE,
        voter: "tp1votera",
        option: "NO",
        metadata: null,
        weight: null,
        submitTime: new Date("2026-07-29T00:02:00Z"),
        height: null,
        txhash: null,
      }),
    );
    const rows = await prisma.govVote.findMany({ where: { proposalId: ID_VOTE } });
    expect(rows).toHaveLength(1);
    // A legitimate re-read IS authoritative for the vote's own content.
    expect(rows[0]!.option).toBe("NO");
    expect(rows[0]!.txhash).toBe("VOTETX");
  });

  it("stores a null weight as NULL, never as 0", async () => {
    await inTx((s) =>
      s.upsertVote({
        proposalId: ID_VOTE,
        voter: "tp1voterb",
        option: "ABSTAIN",
        metadata: null,
        weight: null,
        submitTime: new Date("2026-07-29T00:03:00Z"),
        height: null,
        txhash: null,
      }),
    );
    const row = await prisma.govVote.findUniqueOrThrow({
      where: { proposalId_voter: { proposalId: ID_VOTE, voter: "tp1voterb" } },
    });
    // The module's Vote payload has no weight field. Null means "not
    // recoverable"; a 0 would assert this member's vote counted for nothing.
    expect(row.weight).toBeNull();
    expect(row.height).toBeNull();
    expect(row.txhash).toBeNull();
  });
});
