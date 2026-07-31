// The governance mirror's three load-bearing claims, made executable. Per
// §9 these are where the PR review should spend its effort, so they are asserted
// here rather than left to inspection:
//
//   inv. 2 — replay converges and never regresses (monotonic `observedHeight`)
//   inv. 3 — the voting-period-end transition is OBSERVED, in a txless window
//   inv. 4 — the mirror outlives chain state and never claims otherwise
//
// An in-memory store stands in for Postgres so the property is Postgres-free. It
// mirrors the SQL's semantics EXACTLY — the conditional update arm, the set-once
// COALESCEs, the never-delete rule — and where it cannot (the guard being atomic
// rather than read-compare-write), that is called out: the real protection lives
// in store.ts's `ON CONFLICT … WHERE`, and the DB-backed round-trip
// (test/integration/governance-roundtrip.test.ts) is what proves it.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { GovernanceBatch } from "../../src/workers/governance/sources.ts";
import { applyBatch } from "../../src/workers/governance/write.ts";
import type {
  GovernanceStore,
  ProposalUpsert,
  VoteUpsert,
} from "../../src/workers/governance/store.ts";
import type {
  ExecutorResult,
  ProposalSnapshot,
  ProposalStatus,
  Tally,
} from "../../src/workers/governance/events.ts";

interface Row extends ProposalUpsert {
  prunedAtHeight: bigint | null;
  height: bigint | null;
  txhash: string | null;
}

/** In-memory store with the SAME conditional semantics as the SQL in store.ts. */
class MemStore implements GovernanceStore {
  readonly proposals = new Map<string, Row>();
  readonly votes = new Map<string, VoteUpsert>();

  async upsertProposal(row: ProposalUpsert): Promise<void> {
    const key = row.proposalId.toString();
    const existing = this.proposals.get(key);
    if (existing === undefined) {
      this.proposals.set(key, { ...row, prunedAtHeight: null, height: null, txhash: null });
      return;
    }
    // The conditional arm: a lower observation LOSES. This is the whole
    // convergence property, and in Postgres it is `ON CONFLICT … WHERE
    // observedHeight < EXCLUDED.observedHeight` — atomic, so it holds even with a
    // backfill writing beside the live worker.
    if (existing.observedHeight >= row.observedHeight) return;
    const known = (r: ExecutorResult): boolean => r !== "NOT_RUN" && r !== "UNSPECIFIED";
    this.proposals.set(key, {
      ...existing,
      ...row,
      // `executorResult` is monotone, so a sweep's NOT_RUN default must not erase
      // an outcome the tx plane already established.
      executorResult:
        !known(row.executorResult) && known(existing.executorResult)
          ? existing.executorResult
          : row.executorResult,
      // Never un-prune, and never lose provenance, on a later observation.
      prunedAtHeight: existing.prunedAtHeight,
      height: existing.height,
      txhash: existing.txhash,
    });
  }

  async setSubmitProvenance(proposalId: bigint, txhash: string, height: bigint): Promise<void> {
    const row = this.proposals.get(proposalId.toString());
    if (row === undefined || row.txhash !== null) return; // set-once
    row.txhash = txhash;
    row.height = height;
  }

  async setExecutorResult(proposalId: bigint, result: ExecutorResult): Promise<void> {
    const row = this.proposals.get(proposalId.toString());
    if (row === undefined) return;
    if (row.executorResult !== "NOT_RUN" && row.executorResult !== "UNSPECIFIED") return;
    this.proposals.set(proposalId.toString(), { ...row, executorResult: result });
  }

  async setTerminalState(
    proposalId: bigint,
    status: ProposalStatus,
    tally: Tally | null,
    height: bigint,
  ): Promise<void> {
    const row = this.proposals.get(proposalId.toString());
    if (row === undefined) return;
    this.proposals.set(proposalId.toString(), {
      ...row,
      status,
      ...(tally === null ? {} : { tally }),
      observedHeight: row.observedHeight > height ? row.observedHeight : height,
    });
  }

  async markPruned(proposalId: bigint, height: bigint): Promise<void> {
    const row = this.proposals.get(proposalId.toString());
    if (row === undefined) return;
    // COALESCE: the FIRST height at which we noticed, and never a delete.
    row.prunedAtHeight = row.prunedAtHeight ?? height;
  }

  async storedIdsForPolicies(policies: readonly string[]): Promise<bigint[]> {
    return [...this.proposals.values()]
      .filter((r) => policies.includes(r.groupPolicyAddress) && r.prunedAtHeight === null)
      .map((r) => r.proposalId);
  }

  async existingProposalIds(proposalIds: readonly bigint[]): Promise<Set<string>> {
    return new Set(proposalIds.map((id) => id.toString()).filter((id) => this.proposals.has(id)));
  }

  async upsertVote(row: VoteUpsert): Promise<void> {
    const key = `${row.proposalId}|${row.voter}`;
    const existing = this.votes.get(key);
    this.votes.set(key, {
      ...row,
      metadata: row.metadata ?? existing?.metadata ?? null,
      weight: row.weight ?? existing?.weight ?? null,
      height: existing?.height ?? row.height,
      txhash: existing?.txhash ?? row.txhash,
    });
  }

  /** A comparable snapshot for convergence assertions. */
  digest(): string {
    const props = [...this.proposals.values()]
      .sort((a, b) => Number(a.proposalId - b.proposalId))
      .map((r) =>
        [
          r.proposalId,
          r.status,
          r.executorResult,
          r.tally.yes,
          r.tally.no,
          r.observedHeight,
          r.prunedAtHeight ?? "-",
          r.txhash ?? "-",
        ].join(":"),
      );
    const votes = [...this.votes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, v.option, v.weight ?? "-", v.txhash ?? "-"].join(":"));
    return JSON.stringify({ props, votes });
  }
}

const POLICY = "tp1policy";
const ZERO: Tally = { yes: "0", no: "0", abstain: "0", noWithVeto: "0" };

function snapshot(
  id: bigint,
  status: ProposalStatus,
  tally: Tally = ZERO,
  executorResult: ExecutorResult = "NOT_RUN",
): ProposalSnapshot {
  return {
    proposalId: id,
    groupPolicyAddress: POLICY,
    groupId: 1n,
    proposers: ["tp1a"],
    status,
    executorResult,
    metadata: "",
    title: `proposal ${id}`,
    summary: "",
    messages: [{ "@type": "/cosmos.bank.v1beta1.MsgSend" }],
    submitTime: new Date("2026-07-29T00:00:00Z"),
    votingPeriodEnd: new Date("2026-07-29T00:05:00Z"),
    tally,
    groupVersion: 1n,
    groupPolicyVersion: 1n,
    decisionPolicy: { "@type": "threshold" },
  };
}

function batch(over: Partial<GovernanceBatch> & { observedHeight: bigint }): GovernanceBatch {
  const proposals = over.proposals ?? [];
  return {
    observedAt: new Date(Number(over.observedHeight) * 1000),
    policies: [POLICY],
    recoveredProposals: [],
    stateVotes: [],
    submits: [],
    txVotes: [],
    execResults: [],
    prunes: [],
    withdrawals: [],
    sweepOk: true,
    sweptPolicies: [POLICY],
    ...over,
    proposals,
    presentIds: over.presentIds ?? proposals.map((p) => p.proposalId),
  };
}

describe("invariant 2 — replay converges and never regresses", () => {
  it("a LOWER observation cannot overwrite a higher one", async () => {
    const store = new MemStore();
    await applyBatch(store, batch({ observedHeight: 200n, proposals: [snapshot(1n, "REJECTED")] }));
    // A replay from 0 re-reads state pinned at an OLD height. That state is
    // correct FOR THAT HEIGHT but stale as a mirror, which is exactly the case the
    // guard exists for.
    await applyBatch(
      store,
      batch({ observedHeight: 100n, proposals: [snapshot(1n, "SUBMITTED")] }),
    );
    expect(store.proposals.get("1")!.status).toBe("REJECTED");
    expect(store.proposals.get("1")!.observedHeight).toBe(200n);
  });

  it("converges to the same state regardless of window ORDER (fast-check)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 1, max: 400 }), { minLength: 2, maxLength: 8 }),
        fc.integer({ min: 0, max: 1000 }),
        async (heights, seed) => {
          const ordered = [...heights].sort((a, b) => a - b);
          const statuses: ProposalStatus[] = ["SUBMITTED", "SUBMITTED", "ACCEPTED", "REJECTED"];
          const batches = ordered.map((h, i) =>
            batch({
              observedHeight: BigInt(h),
              proposals: [
                snapshot(1n, statuses[Math.min(i, statuses.length - 1)]!, {
                  ...ZERO,
                  yes: String(i),
                }),
              ],
            }),
          );

          const inOrder = new MemStore();
          for (const b of batches) await applyBatch(inOrder, b);

          // A deterministic shuffle from the seed — the arrival order a resume or a
          // backfill-beside-live actually produces.
          const shuffled = [...batches];
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = (seed * (i + 7)) % (i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
          }
          const outOfOrder = new MemStore();
          for (const b of shuffled) await applyBatch(outOfOrder, b);

          // Convergence is a property of the guard, not of scheduling.
          expect(outOfOrder.digest()).toBe(inOrder.digest());
        },
      ),
      { numRuns: 60 },
    );
  });

  it("is idempotent: re-applying the same window changes nothing", async () => {
    const store = new MemStore();
    const b = batch({
      observedHeight: 50n,
      proposals: [snapshot(1n, "SUBMITTED")],
      submits: [{ proposalId: 1n, txhash: "AABB", height: 45n, msgIndex: 0 }],
      txVotes: [
        {
          proposalId: 1n,
          voter: "tp1a",
          option: "YES",
          metadata: "",
          txhash: "CCDD",
          height: 46n,
          msgIndex: 0,
          blockTime: new Date("2026-07-29T00:01:00Z"),
        },
      ],
    });
    await applyBatch(store, b);
    const first = store.digest();
    await applyBatch(store, b);
    expect(store.digest()).toBe(first);
  });

  it("submit provenance is set-once — a replay cannot rewrite it", async () => {
    const store = new MemStore();
    await applyBatch(
      store,
      batch({
        observedHeight: 50n,
        proposals: [snapshot(1n, "SUBMITTED")],
        submits: [{ proposalId: 1n, txhash: "FIRST", height: 40n, msgIndex: 0 }],
      }),
    );
    await applyBatch(
      store,
      batch({
        observedHeight: 60n,
        proposals: [snapshot(1n, "SUBMITTED")],
        submits: [{ proposalId: 1n, txhash: "SECOND", height: 41n, msgIndex: 0 }],
      }),
    );
    expect(store.proposals.get("1")!.txhash).toBe("FIRST");
  });
});

describe("invariant 3 — the voting-period-end transition is OBSERVED, not inferred", () => {
  it("a window with NO transaction flips SUBMITTED -> REJECTED", async () => {
    const store = new MemStore();
    await applyBatch(
      store,
      batch({ observedHeight: 100n, proposals: [snapshot(1n, "SUBMITTED")] }),
    );
    expect(store.proposals.get("1")!.status).toBe("SUBMITTED");

    // The transition is eventless on this build — no tally event exists in
    // finalize_block_events — so the state sweep is its ONLY observer. Note the
    // batch below carries no submits, votes, execs or prunes at all.
    const txless = batch({
      observedHeight: 140n,
      proposals: [snapshot(1n, "REJECTED", { ...ZERO, no: "1" })],
    });
    expect(txless.submits).toEqual([]);
    expect(txless.execResults).toEqual([]);
    expect(txless.prunes).toEqual([]);
    await applyBatch(store, txless);

    expect(store.proposals.get("1")!.status).toBe("REJECTED");
    expect(store.proposals.get("1")!.observedHeight).toBe(140n);
  });

  it("never writes NOT_RUN over a real execution outcome", async () => {
    const store = new MemStore();
    await applyBatch(
      store,
      batch({
        observedHeight: 100n,
        proposals: [snapshot(1n, "ACCEPTED")],
        execResults: [{ proposalId: 1n, result: "FAILURE", height: 95n }],
      }),
    );
    expect(store.proposals.get("1")!.executorResult).toBe("FAILURE");
    // A later sweep reports the chain's own NOT_RUN default for a row whose
    // outcome we already know; the write path must not regress it.
    await applyBatch(
      store,
      batch({ observedHeight: 200n, proposals: [snapshot(1n, "ACCEPTED", ZERO, "NOT_RUN")] }),
    );
    expect(store.proposals.get("1")!.executorResult).toBe("FAILURE");
  });
});

describe("invariant 4 — the mirror outlives chain state and never claims otherwise", () => {
  // THE ONE-WINDOW-LIFECYCLE REGRESSION. The case below it ("from EVENTS ALONE") seeded the
  // row in a PRIOR window and only then applied the prune — so it verified the
  // easy variant and never the real one, which is precisely the failure the
  // §4b apparatus was built to prevent: a named, gated invariant that passes while
  // the defect it names is live.
  //
  // A proposal submitted, executed and pruned inside ONE window is absent from
  // that window's ending sweep, and every event-derived write is an UPDATE — so
  // with no base row the whole lifecycle silently affected zero rows. This is the
  // COMMON case, not an edge: a successful exec prunes in its own transaction and
  // a 500-height window is about eight minutes.
  it("records a proposal whose ENTIRE lifecycle fell inside one window", async () => {
    const store = new MemStore();
    await applyBatch(
      store,
      batch({
        observedHeight: 500n,
        // Absent from the sweep — already pruned by the time the window ended.
        proposals: [],
        presentIds: [],
        // Recovered by a height-pinned read at a height it was still alive at.
        recoveredProposals: [{ snapshot: snapshot(9n, "SUBMITTED"), observedHeight: 100n }],
        submits: [{ proposalId: 9n, txhash: "SUBMITTX", height: 100n, msgIndex: 0 }],
        txVotes: [
          {
            proposalId: 9n,
            voter: "tp1a",
            option: "YES",
            metadata: "",
            txhash: "VOTETX",
            height: 110n,
            msgIndex: 0,
            blockTime: new Date("2026-07-29T00:01:00Z"),
          },
        ],
        execResults: [{ proposalId: 9n, result: "SUCCESS", height: 120n }],
        prunes: [
          {
            proposalId: 9n,
            status: "ACCEPTED",
            tally: { yes: "2", no: "0", abstain: "0", noWithVeto: "0" },
            height: 120n,
          },
        ],
      }),
    );

    const row = store.proposals.get("9");
    expect(row, "the proposal must exist in the mirror").toBeDefined();
    expect(row!.status).toBe("ACCEPTED");
    expect(row!.executorResult).toBe("SUCCESS");
    expect(row!.tally.yes).toBe("2");
    expect(row!.txhash).toBe("SUBMITTX");
    expect(row!.prunedAtHeight).toBe(120n);
    // The recovered row's AS-OF starts at the height it was read at, then the
    // terminal event raises it — never the window's end, at which the chain no
    // longer held it.
    expect(row!.observedHeight).toBe(120n);
    // And its vote is stored, not orphaned.
    expect(store.votes.get("9|tp1a")?.txhash).toBe("VOTETX");
  });

  it("refuses ORPHAN votes when the proposal could not be recovered at all", async () => {
    // A pinned read below a pruning node's retention horizon recovers nothing
    // (app-spec §9.3). Losing the proposal is then unavoidable, but storing its
    // votes anyway would leave rows the detail endpoint can never reach — and which
    // assert participation in a proposal the mirror cannot show.
    const store = new MemStore();
    await applyBatch(
      store,
      batch({
        observedHeight: 500n,
        proposals: [],
        presentIds: [],
        recoveredProposals: [],
        submits: [{ proposalId: 11n, txhash: "SUBMITTX", height: 100n, msgIndex: 0 }],
        txVotes: [
          {
            proposalId: 11n,
            voter: "tp1a",
            option: "YES",
            metadata: "",
            txhash: "VOTETX",
            height: 110n,
            msgIndex: 0,
            blockTime: new Date("2026-07-29T00:01:00Z"),
          },
        ],
      }),
    );
    expect(store.proposals.size).toBe(0);
    expect(store.votes.size, "no orphan votes").toBe(0);
  });

  it("records ACCEPTED + SUCCESS from EVENTS ALONE, a pair no state read can return", async () => {
    // The happy path leaves nothing behind: a successful exec prunes the proposal
    // in its own transaction. The row exists only because the events carried the
    // terminal status and the tally.
    const store = new MemStore();
    await applyBatch(store, batch({ observedHeight: 90n, proposals: [snapshot(7n, "SUBMITTED")] }));
    await applyBatch(
      store,
      batch({
        observedHeight: 100n,
        proposals: [], // absent from the sweep — already pruned
        presentIds: [],
        execResults: [{ proposalId: 7n, result: "SUCCESS", height: 96n }],
        prunes: [
          {
            proposalId: 7n,
            status: "ACCEPTED",
            tally: { yes: "2", no: "0", abstain: "1", noWithVeto: "0" },
            height: 96n,
          },
        ],
      }),
    );
    const row = store.proposals.get("7")!;
    expect(row.status).toBe("ACCEPTED");
    expect(row.executorResult).toBe("SUCCESS");
    expect(row.tally.yes).toBe("2");
    expect(row.prunedAtHeight).toBe(96n);
  });

  it("a prune PRESERVES the row — never deletes, never nulls", async () => {
    const store = new MemStore();
    await applyBatch(
      store,
      batch({
        observedHeight: 90n,
        proposals: [snapshot(3n, "SUBMITTED")],
        submits: [{ proposalId: 3n, txhash: "AABB", height: 80n, msgIndex: 0 }],
      }),
    );
    await applyBatch(
      store,
      batch({
        observedHeight: 100n,
        proposals: [],
        presentIds: [],
        prunes: [{ proposalId: 3n, status: "WITHDRAWN", tally: null, height: 99n }],
      }),
    );
    const row = store.proposals.get("3")!;
    expect(row.status).toBe("WITHDRAWN");
    expect(row.txhash).toBe("AABB");
    expect(row.title).toBe("proposal 3");
    expect(store.proposals.size).toBe(1);
  });

  it("stamps the FIRST prune height, not the latest", async () => {
    const store = new MemStore();
    await applyBatch(store, batch({ observedHeight: 90n, proposals: [snapshot(4n, "SUBMITTED")] }));
    await applyBatch(
      store,
      batch({
        observedHeight: 100n,
        proposals: [],
        presentIds: [],
        prunes: [{ proposalId: 4n, status: "REJECTED", tally: null, height: 95n }],
      }),
    );
    await applyBatch(
      store,
      batch({
        observedHeight: 200n,
        proposals: [],
        presentIds: [],
        prunes: [{ proposalId: 4n, status: "REJECTED", tally: null, height: 195n }],
      }),
    );
    expect(store.proposals.get("4")!.prunedAtHeight).toBe(95n);
  });

  it("infers a prune from ABSENCE in a successful sweep", async () => {
    const store = new MemStore();
    await applyBatch(store, batch({ observedHeight: 90n, proposals: [snapshot(5n, "SUBMITTED")] }));
    // No prune event this window — the EndBlocker's prune may have been missed —
    // but a SUCCESSFUL enumeration proves the chain no longer holds it.
    await applyBatch(
      store,
      batch({ observedHeight: 150n, proposals: [], presentIds: [], sweepOk: true }),
    );
    expect(store.proposals.get("5")!.prunedAtHeight).toBe(150n);
  });

  // THE DISPROOF, and it is a live hazard rather than a hypothetical: a missing
  // proposal and an LCD outage are indistinguishable at the transport (both answer
  // HTTP 500 with the same body). If absence-on-failure were treated as a prune,
  // an outage would durably assert "the chain discarded this" about live
  // governance.
  it("does NOT infer a prune when the sweep FAILED", async () => {
    const store = new MemStore();
    await applyBatch(store, batch({ observedHeight: 90n, proposals: [snapshot(6n, "SUBMITTED")] }));
    await applyBatch(
      store,
      batch({ observedHeight: 150n, proposals: [], presentIds: [], sweepOk: false }),
    );
    expect(store.proposals.get("6")!.prunedAtHeight).toBeNull();
    expect(store.proposals.get("6")!.status).toBe("SUBMITTED");
  });

  it("does NOT infer a prune when NO policy was swept (the ungoverned chain)", async () => {
    const store = new MemStore();
    await applyBatch(store, batch({ observedHeight: 90n, proposals: [snapshot(8n, "SUBMITTED")] }));
    // An ungoverned chain yields no policies at all. Concluding absence here would
    // stamp every stored proposal pruned the moment discovery hiccupped.
    await applyBatch(
      store,
      batch({
        observedHeight: 150n,
        proposals: [],
        presentIds: [],
        sweepOk: false,
        sweptPolicies: [],
      }),
    );
    expect(store.proposals.get("8")!.prunedAtHeight).toBeNull();
  });
});

describe("votes — the durable per-voter record", () => {
  it("keeps tx provenance when a later state read has none", async () => {
    const store = new MemStore();
    await applyBatch(
      store,
      batch({
        observedHeight: 100n,
        proposals: [snapshot(1n, "SUBMITTED")],
        txVotes: [
          {
            proposalId: 1n,
            voter: "tp1a",
            option: "YES",
            metadata: "rationale",
            txhash: "VOTETX",
            height: 95n,
            msgIndex: 0,
            blockTime: new Date("2026-07-29T00:01:00Z"),
          },
        ],
        stateVotes: [
          {
            proposalId: 1n,
            voter: "tp1a",
            option: "YES",
            metadata: "rationale",
            submitTime: new Date("2026-07-29T00:01:00Z"),
            weight: "2",
          },
        ],
      }),
    );
    const vote = store.votes.get("1|tp1a")!;
    // Provenance from the tx plane, weight from the state plane — neither erases
    // the other.
    expect(vote.txhash).toBe("VOTETX");
    expect(vote.height).toBe(95n);
    expect(vote.weight).toBe("2");
  });

  it("an EMPTY state read never deletes recorded votes", async () => {
    // The module deletes votes at the voting-period-end tally, so every closed
    // proposal's vote read comes back empty. That must not propagate.
    const store = new MemStore();
    await applyBatch(
      store,
      batch({
        observedHeight: 100n,
        proposals: [snapshot(1n, "SUBMITTED")],
        txVotes: [
          {
            proposalId: 1n,
            voter: "tp1a",
            option: "YES",
            metadata: "",
            txhash: "VOTETX",
            height: 95n,
            msgIndex: 0,
            blockTime: new Date("2026-07-29T00:01:00Z"),
          },
        ],
      }),
    );
    await applyBatch(
      store,
      batch({ observedHeight: 200n, proposals: [snapshot(1n, "REJECTED")], stateVotes: [] }),
    );
    expect(store.votes.size).toBe(1);
    expect(store.votes.get("1|tp1a")!.txhash).toBe("VOTETX");
  });

  it("keys votes by (proposalId, voter) — two votes in one tx are both kept", async () => {
    const store = new MemStore();
    await applyBatch(
      store,
      batch({
        observedHeight: 100n,
        proposals: [snapshot(1n, "SUBMITTED"), snapshot(2n, "SUBMITTED")],
        txVotes: [0, 1].map((i) => ({
          proposalId: BigInt(i + 1),
          voter: "tp1a",
          option: "YES" as const,
          metadata: `batch-${i}`,
          txhash: "ONETX",
          height: 95n,
          msgIndex: i,
          blockTime: new Date("2026-07-29T00:01:00Z"),
        })),
      }),
    );
    // Same voter, same transaction, different proposals. A txhash-keyed store
    // would have kept one.
    expect(store.votes.size).toBe(2);
  });
});
