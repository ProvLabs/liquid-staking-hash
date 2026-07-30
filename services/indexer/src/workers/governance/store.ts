// The governance Store: the abstract seam the writer folds over (Postgres here,
// in-memory in the replay property test), bound to one window's transaction
// client so every write commits atomically with the cursor advance.
//
// THE ONE THING TO UNDERSTAND IN THIS FILE is why the upserts are raw SQL rather
// than `prisma.upsert`. The replay guarantee is that a window which observed the
// chain at height H must never overwrite a row already observed at H' > H — and
// that has to be a property of the SQL STATEMENT, not of application logic
// (M7.1 §4b C3). Prisma's `upsert` cannot express a conditional update arm, so a
// read-compare-write would be the only alternative, and that would make
// convergence depend on stream scheduling: two writers (a backfill running beside
// the live worker — a real scenario, not a hypothetical) could interleave between
// the read and the write and land the older observation last.
//
// `INSERT … ON CONFLICT DO UPDATE … WHERE gov_proposals."observedHeight" < EXCLUDED."observedHeight"`
// makes the guard atomic inside Postgres. Convergence is then a property of the
// statement, and "unlikely by topology" — the assumption class SECURITY.md
// forbids relying on — never enters into it.
//
// Amount discipline: tally counts and weights are Decimal(39,0) and cross the
// boundary as canonical integer STRINGS. They are unbounded chain integers, so
// the JS-number boundary is never crossed (app-spec §5.8).

import type { Prisma } from "@prisma/client";
import type { ProposalStatus, ExecutorResult, Tally, VoteOption } from "./events.ts";

/** A full proposal observation — the authoritative state-plane row. */
export interface ProposalUpsert {
  readonly proposalId: bigint;
  readonly groupPolicyAddress: string;
  readonly groupId: bigint;
  readonly proposers: string[];
  readonly status: ProposalStatus;
  readonly executorResult: ExecutorResult;
  readonly metadata: string | null;
  readonly title: string;
  readonly summary: string;
  readonly messages: unknown[];
  readonly submitTime: Date;
  readonly votingPeriodEnd: Date;
  readonly tally: Tally;
  readonly groupVersion: bigint;
  readonly groupPolicyVersion: bigint;
  readonly decisionPolicy: unknown;
  readonly observedHeight: bigint;
  readonly observedAt: Date;
}

export interface VoteUpsert {
  readonly proposalId: bigint;
  readonly voter: string;
  readonly option: VoteOption;
  readonly metadata: string | null;
  readonly weight: string | null;
  readonly submitTime: Date;
  readonly height: bigint | null;
  readonly txhash: string | null;
}

export interface GovernanceStore {
  /** Upsert a proposal observation under the monotonic `observedHeight` guard. */
  upsertProposal(row: ProposalUpsert): Promise<void>;
  /** Attach submit provenance, only where it is still absent (set-once). */
  setSubmitProvenance(proposalId: bigint, txhash: string, height: bigint): Promise<void>;
  /** Record an execution outcome the state plane cannot hold. */
  setExecutorResult(proposalId: bigint, result: ExecutorResult, height: bigint): Promise<void>;
  /** Record a terminal status (+ tally) observed as the chain discarded the row. */
  setTerminalState(
    proposalId: bigint,
    status: ProposalStatus,
    tally: Tally | null,
    height: bigint,
  ): Promise<void>;
  /** Stamp a proposal as no longer held on chain. Never deletes. */
  markPruned(proposalId: bigint, height: bigint): Promise<void>;
  /** Proposal ids stored for the given policies — the absence diff's left side. */
  storedIdsForPolicies(policies: readonly string[]): Promise<bigint[]>;
  /** Upsert a vote. Provenance is set-once; a null never overwrites a value. */
  upsertVote(row: VoteUpsert): Promise<void>;
}

/** Prisma `Decimal`-ish -> canonical integer string. */
function toDecimalString(value: unknown): string {
  if (value === null || value === undefined) return "0";
  const v = value as { toFixed?: (dp: number) => string };
  return typeof v.toFixed === "function" ? v.toFixed(0) : String(value);
}

export class PrismaGovernanceStore implements GovernanceStore {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async upsertProposal(row: ProposalUpsert): Promise<void> {
    // The conditional-update arm is the whole reason this is raw SQL. See the
    // file header: a lower observation must lose to a higher one inside the
    // statement, not inside a read-compare-write.
    //
    // `prunedAtHeight` is deliberately NOT in the update list: a proposal the
    // sweep can still see may have been pruned-and-resurrected in no scenario,
    // but a stale window re-reading old state must never un-prune a row.
    await this.tx.$executeRaw`
      INSERT INTO "indexed"."gov_proposals" (
        "proposalId", "groupPolicyAddress", "groupId", "proposers", "status", "executorResult",
        "metadata", "title", "summary", "messages", "submitTime", "votingPeriodEnd",
        "yesCount", "noCount", "abstainCount", "noWithVetoCount",
        "groupVersion", "groupPolicyVersion", "decisionPolicy", "observedHeight", "observedAt"
      ) VALUES (
        ${row.proposalId}, ${row.groupPolicyAddress}, ${row.groupId}, ${row.proposers},
        ${row.status}, ${row.executorResult}, ${row.metadata}, ${row.title}, ${row.summary},
        ${JSON.stringify(row.messages)}::jsonb, ${row.submitTime}, ${row.votingPeriodEnd},
        ${row.tally.yes}::decimal, ${row.tally.no}::decimal,
        ${row.tally.abstain}::decimal, ${row.tally.noWithVeto}::decimal,
        ${row.groupVersion}, ${row.groupPolicyVersion},
        ${JSON.stringify(row.decisionPolicy ?? null)}::jsonb, ${row.observedHeight}, ${row.observedAt}
      )
      ON CONFLICT ("proposalId") DO UPDATE SET
        "groupPolicyAddress" = EXCLUDED."groupPolicyAddress",
        "groupId"            = EXCLUDED."groupId",
        "proposers"          = EXCLUDED."proposers",
        "status"             = EXCLUDED."status",
        -- executorResult is MONOTONE: NOT_RUN -> SUCCESS|FAILURE, once, never
        -- back. So a sweep reporting the chain's NOT_RUN default must not erase an
        -- outcome we already learned from the tx plane. Without this arm the
        -- setExecutorResult guard was bypassed by the very next window's upsert
        -- (caught by the replay suite, not by review).
        -- NB: no backticks in SQL comments here — this is a tagged template, and
        -- a backtick would silently terminate the literal.
        "executorResult"     = CASE
          WHEN EXCLUDED."executorResult" IN ('NOT_RUN', 'UNSPECIFIED')
           AND "indexed"."gov_proposals"."executorResult" NOT IN ('NOT_RUN', 'UNSPECIFIED')
          THEN "indexed"."gov_proposals"."executorResult"
          ELSE EXCLUDED."executorResult"
        END,
        "metadata"           = EXCLUDED."metadata",
        "title"              = EXCLUDED."title",
        "summary"            = EXCLUDED."summary",
        "messages"           = EXCLUDED."messages",
        "submitTime"         = EXCLUDED."submitTime",
        "votingPeriodEnd"    = EXCLUDED."votingPeriodEnd",
        "yesCount"           = EXCLUDED."yesCount",
        "noCount"            = EXCLUDED."noCount",
        "abstainCount"       = EXCLUDED."abstainCount",
        "noWithVetoCount"    = EXCLUDED."noWithVetoCount",
        "groupVersion"       = EXCLUDED."groupVersion",
        "groupPolicyVersion" = EXCLUDED."groupPolicyVersion",
        "decisionPolicy"     = EXCLUDED."decisionPolicy",
        "observedHeight"     = EXCLUDED."observedHeight",
        "observedAt"         = EXCLUDED."observedAt"
      WHERE "indexed"."gov_proposals"."observedHeight" < EXCLUDED."observedHeight"`;
  }

  async setSubmitProvenance(proposalId: bigint, txhash: string, height: bigint): Promise<void> {
    // Set-once via `IS NULL`, so a replay cannot rewrite provenance and two
    // writers cannot disagree about it.
    await this.tx.$executeRaw`
      UPDATE "indexed"."gov_proposals"
         SET "txhash" = ${txhash}, "height" = ${height}
       WHERE "proposalId" = ${proposalId} AND "txhash" IS NULL`;
  }

  async setExecutorResult(
    proposalId: bigint,
    result: ExecutorResult,
    _height: bigint,
  ): Promise<void> {
    // Write-once over the placeholder values, which makes this idempotent and
    // ORDER-INDEPENDENT without needing a height comparison at all: an execution
    // happens once, so `NOT_RUN -> SUCCESS|FAILURE` is a one-way transition and a
    // replay re-reading the same transaction writes the same value.
    //
    // Deliberately NOT touching `status`. An exec implies the proposal was
    // accepted, but inferring it here would violate invariant 3 — non-tx
    // transitions are OBSERVED, not deduced — and the real terminal status
    // arrives on `EventProposalPruned`, which carries it explicitly.
    await this.tx.$executeRaw`
      UPDATE "indexed"."gov_proposals"
         SET "executorResult" = ${result}
       WHERE "proposalId" = ${proposalId}
         AND "executorResult" IN ('NOT_RUN', 'UNSPECIFIED')`;
  }

  async setTerminalState(
    proposalId: bigint,
    status: ProposalStatus,
    tally: Tally | null,
    height: bigint,
  ): Promise<void> {
    if (tally === null) {
      await this.tx.$executeRaw`
        UPDATE "indexed"."gov_proposals"
           SET "status" = ${status}, "observedHeight" = GREATEST("observedHeight", ${height})
         WHERE "proposalId" = ${proposalId}`;
      return;
    }
    await this.tx.$executeRaw`
      UPDATE "indexed"."gov_proposals"
         SET "status"          = ${status},
             "yesCount"        = ${tally.yes}::decimal,
             "noCount"         = ${tally.no}::decimal,
             "abstainCount"    = ${tally.abstain}::decimal,
             "noWithVetoCount" = ${tally.noWithVeto}::decimal,
             "observedHeight"  = GREATEST("observedHeight", ${height})
       WHERE "proposalId" = ${proposalId}`;
  }

  async markPruned(proposalId: bigint, height: bigint): Promise<void> {
    // Set-once and NEVER a delete: the row is the durable record precisely
    // because the chain has stopped being one. `COALESCE` keeps the FIRST height
    // at which we noticed, so a later window cannot restate when it happened.
    await this.tx.$executeRaw`
      UPDATE "indexed"."gov_proposals"
         SET "prunedAtHeight" = COALESCE("prunedAtHeight", ${height})
       WHERE "proposalId" = ${proposalId}`;
  }

  async storedIdsForPolicies(policies: readonly string[]): Promise<bigint[]> {
    if (policies.length === 0) return [];
    const rows = await this.tx.govProposal.findMany({
      where: { groupPolicyAddress: { in: [...policies] }, prunedAtHeight: null },
      select: { proposalId: true },
    });
    return rows.map((r) => r.proposalId);
  }

  async upsertVote(row: VoteUpsert): Promise<void> {
    // Provenance and weight are filled in with COALESCE, so a state-recovered
    // vote (no txhash) never erases the tx-plane record of the same vote, and a
    // vote read after the member set changed never nulls a weight we captured.
    // The vote's own content DOES update: a legitimate re-read is authoritative.
    await this.tx.$executeRaw`
      INSERT INTO "indexed"."gov_votes" (
        "proposalId", "voter", "option", "metadata", "weight", "submitTime", "height", "txhash"
      ) VALUES (
        ${row.proposalId}, ${row.voter}, ${row.option}, ${row.metadata},
        ${row.weight === null ? null : row.weight}::decimal,
        ${row.submitTime}, ${row.height}, ${row.txhash}
      )
      ON CONFLICT ("proposalId", "voter") DO UPDATE SET
        "option"     = EXCLUDED."option",
        "metadata"   = COALESCE(EXCLUDED."metadata", "indexed"."gov_votes"."metadata"),
        "weight"     = COALESCE(EXCLUDED."weight", "indexed"."gov_votes"."weight"),
        "submitTime" = EXCLUDED."submitTime",
        "height"     = COALESCE("indexed"."gov_votes"."height", EXCLUDED."height"),
        "txhash"     = COALESCE("indexed"."gov_votes"."txhash", EXCLUDED."txhash")`;
  }
}

export { toDecimalString };
