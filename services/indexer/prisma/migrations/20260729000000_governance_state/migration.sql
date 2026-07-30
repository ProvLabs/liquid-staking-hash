-- x/group governance mirror (App plan PR 7.1 commit B).
--
-- `gov_proposals` and `gov_votes` have existed since 20260715013707_init with
-- nine and six columns, and NOTHING has ever written them: the devnet had no
-- x/group substrate at all until commit A of this PR bootstrapped one. Standing
-- the mirror up showed the original columns cannot express what app-spec §8.7
-- requires. The additions are a DESIGN-REVIEW EVENT approved in advance (M7
-- overview decision D3, app-spec §9.1 forward note), and every one is public
-- chain data — a proposal payload, a tally of member weights, a height, a
-- status. Nothing is identity-, device- or IP-shaped, and the
-- test/security/allowed-fields.ts edit in this same change is what gates that.
--
-- Because nothing has ever written these tables, the "backfill" for every NOT
-- NULL column is vacuous: the tables are empty in every environment. The
-- defaults below exist so the DDL is valid on a non-empty table too (a
-- developer who hand-inserted a row), and they are dropped immediately after so
-- no future insert can quietly take a fabricated default instead of a real
-- chain value.
--
-- Three of these columns exist because of things the 2026-07-29 devnet drill
-- OBSERVED, not because of things the plan predicted:
--
--   * `executorResult` — a proposal that executes successfully is PRUNED in the
--     same transaction, so `ACCEPTED` + `SUCCESS` is a pair no chain read can
--     return; and `ACCEPTED` + `FAILURE` ("it passed, then the messages failed")
--     is invisible in `status` alone.
--   * `prunedAtHeight` — the chain routinely stops holding what this table
--     holds. It is written ONLY from an authoritative signal (absence from a
--     SUCCESSFUL paginated policy sweep, or an observed EventProposalPruned),
--     never from a failed read: the LCD answers a missing proposal with HTTP 500
--     whose body is identical for a pruned id and one that never existed, and a
--     node outage answers 500 too.
--   * `gov_votes.weight` — the module's Vote payload carries no weight field, and
--     votes are DELETED at the voting-period-end tally even for a proposal that
--     passes. Null means "not recoverable", never 0.

-- --- gov_proposals ---------------------------------------------------------

-- `proposers` REPLACES `proposer`: x/group permits several proposers and makes
-- each one a required signer, so one scalar column was a lie whenever there
-- were two.
ALTER TABLE "indexed"."gov_proposals" ADD COLUMN "proposers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "indexed"."gov_proposals" SET "proposers" = ARRAY["proposer"] WHERE "proposer" IS NOT NULL;
ALTER TABLE "indexed"."gov_proposals" DROP COLUMN "proposer";
ALTER TABLE "indexed"."gov_proposals" ALTER COLUMN "proposers" DROP DEFAULT;

ALTER TABLE "indexed"."gov_proposals"
  ADD COLUMN "groupId"            BIGINT        NOT NULL DEFAULT 0,
  ADD COLUMN "executorResult"     TEXT          NOT NULL DEFAULT 'NOT_RUN',
  ADD COLUMN "title"              TEXT          NOT NULL DEFAULT '',
  ADD COLUMN "summary"            TEXT          NOT NULL DEFAULT '',
  ADD COLUMN "votingPeriodEnd"    TIMESTAMP(3)  NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  ADD COLUMN "yesCount"           DECIMAL(39,0) NOT NULL DEFAULT 0,
  ADD COLUMN "noCount"            DECIMAL(39,0) NOT NULL DEFAULT 0,
  ADD COLUMN "abstainCount"       DECIMAL(39,0) NOT NULL DEFAULT 0,
  ADD COLUMN "noWithVetoCount"    DECIMAL(39,0) NOT NULL DEFAULT 0,
  ADD COLUMN "groupVersion"       BIGINT        NOT NULL DEFAULT 0,
  ADD COLUMN "groupPolicyVersion" BIGINT        NOT NULL DEFAULT 0,
  ADD COLUMN "decisionPolicy"     JSONB         NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN "observedHeight"     BIGINT        NOT NULL DEFAULT 0,
  ADD COLUMN "observedAt"         TIMESTAMP(3)  NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  ADD COLUMN "prunedAtHeight"     BIGINT;

-- Drop every default: a governance row must carry OBSERVED chain values. Leaving
-- these in place would let a future insert store a fabricated tally or a
-- 1970 voting-period end and have it read as fact — precisely the
-- never-lie-about-state failure the mirror exists to prevent.
ALTER TABLE "indexed"."gov_proposals"
  ALTER COLUMN "groupId"            DROP DEFAULT,
  ALTER COLUMN "executorResult"     DROP DEFAULT,
  ALTER COLUMN "title"              DROP DEFAULT,
  ALTER COLUMN "summary"            DROP DEFAULT,
  ALTER COLUMN "votingPeriodEnd"    DROP DEFAULT,
  ALTER COLUMN "yesCount"           DROP DEFAULT,
  ALTER COLUMN "noCount"            DROP DEFAULT,
  ALTER COLUMN "abstainCount"       DROP DEFAULT,
  ALTER COLUMN "noWithVetoCount"    DROP DEFAULT,
  ALTER COLUMN "groupVersion"       DROP DEFAULT,
  ALTER COLUMN "groupPolicyVersion" DROP DEFAULT,
  ALTER COLUMN "decisionPolicy"     DROP DEFAULT,
  ALTER COLUMN "observedHeight"     DROP DEFAULT,
  ALTER COLUMN "observedAt"         DROP DEFAULT;

-- Submit provenance becomes NULLABLE. A proposal first seen by the height-pinned
-- state sweep — one submitted before the stream's start height, or whose tx
-- history the node has pruned — has no submit transaction to point at. Null is
-- the honest value; a fabricated height is not, and `indexed_from_height` on the
-- list payload is what tells a reader that window exists.
ALTER TABLE "indexed"."gov_proposals" ALTER COLUMN "height" DROP NOT NULL;
ALTER TABLE "indexed"."gov_proposals" ALTER COLUMN "txhash" DROP NOT NULL;

-- Proposals per policy number in the tens, not the 300 000 rows that forced
-- keyset streaming on operator_payments, so this composite index is for ordered
-- per-policy reads and nothing more. Deliberately NOT keyset machinery.
CREATE INDEX "gov_proposals_groupPolicyAddress_proposalId_idx"
  ON "indexed"."gov_proposals" ("groupPolicyAddress", "proposalId");

-- --- gov_votes ------------------------------------------------------------

ALTER TABLE "indexed"."gov_votes"
  ADD COLUMN "metadata" TEXT,
  ADD COLUMN "weight"   DECIMAL(39,0);

-- Same honesty rule as above, and here it is the COMMON case rather than the
-- edge one: votes survive on chain only while a proposal is open, so a vote
-- recovered from a state sweep genuinely has no transaction provenance.
ALTER TABLE "indexed"."gov_votes" ALTER COLUMN "height" DROP NOT NULL;
ALTER TABLE "indexed"."gov_votes" ALTER COLUMN "txhash" DROP NOT NULL;
