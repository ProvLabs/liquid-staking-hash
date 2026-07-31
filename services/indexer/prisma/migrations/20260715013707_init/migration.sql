-- Baseline DDL for the `indexed` domain: the entire schema in one migration,
-- generated from the `prisma/*.prisma` models. Every object is schema-qualified,
-- so it lands in `indexed` regardless of the connection's search_path.
--
-- Applied AS `indexer_writer`, the role that owns the schema (ADR-001
-- Decision 1) — object ownership is what the grant-boundary gate asserts.

-- CreateSchema
--
-- Guarded by an existence check rather than written `CREATE SCHEMA IF NOT
-- EXISTS`: that form still requires CREATE on the DATABASE, which
-- `indexer_writer` does not hold and must not be granted — it owns the schema
-- infra/dev/postgres/roles.sql created for it, nothing wider. The guard skips
-- the statement entirely there, and still creates the schema on a bare database
-- whose connecting role can (the migration must run clean on an empty DB).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_namespace WHERE nspname = 'indexed') THEN
    EXECUTE 'CREATE SCHEMA "indexed"';
  END IF;
END
$$;

-- CreateEnum
CREATE TYPE "indexed"."IncidentKind" AS ENUM ('contract_halted', 'vault_paused', 'slash_write_down', 'redemption_refund', 'jail_report', 'epoch_overdue', 'reconciler_divergence', 'indexer_lag');

-- CreateEnum
CREATE TYPE "indexed"."IncidentSeverity" AS ENUM ('info', 'warning', 'critical');

-- CreateEnum
CREATE TYPE "indexed"."OperatorPaymentType" AS ENUM ('commission', 'tip');

-- CreateEnum
CREATE TYPE "indexed"."RedemptionStatus" AS ENUM ('enqueued', 'expedited', 'matured', 'refunded');

-- CreateEnum
CREATE TYPE "indexed"."TransactionKind" AS ENUM ('swap_in', 'swap_out_request', 'redemption_payout', 'redemption_refund', 'transfer_in', 'transfer_out');

-- CreateTable
CREATE TABLE "indexed"."bridge_supply_samples" (
    "id" BIGSERIAL NOT NULL,
    "chain" TEXT NOT NULL,
    "remoteSupply" DECIMAL(39,0) NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bridge_supply_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexed"."epoch_snapshots" (
    "epochIndex" BIGINT NOT NULL,
    "startedAtSeconds" BIGINT NOT NULL,
    "endedAtSeconds" BIGINT NOT NULL,
    "endHeight" BIGINT NOT NULL,
    "tvvBefore" DECIMAL(39,0) NOT NULL,
    "tvvAfter" DECIMAL(39,0) NOT NULL,
    "totalShares" DECIMAL(39,0) NOT NULL,
    "rewardsClaimed" DECIMAL(39,0) NOT NULL,
    "commissionReceived" DECIMAL(39,0) NOT NULL,
    "tipsReceived" DECIMAL(39,0) NOT NULL,
    "rewardsDeposited" DECIMAL(39,0) NOT NULL,
    "settled" DECIMAL(39,0) NOT NULL,
    "writeDown" DECIMAL(39,0) NOT NULL,
    "deployed" DECIMAL(39,0) NOT NULL,
    "rebalanced" DECIMAL(39,0) NOT NULL,
    "unbondedForRedemptions" DECIMAL(39,0) NOT NULL,
    "aumFeeEstimate" DECIMAL(39,0) NOT NULL,
    "netDeposits" DECIMAL(39,0) NOT NULL,
    "redemptionsExpedited" INTEGER NOT NULL,
    "validatorsPurged" INTEGER NOT NULL,
    "eligibleCount" INTEGER NOT NULL,
    "grossAprBps" INTEGER NOT NULL,
    "netAprBps" INTEGER NOT NULL,
    "txhash" TEXT NOT NULL,
    "height" BIGINT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "epoch_snapshots_pkey" PRIMARY KEY ("epochIndex")
);

-- CreateTable
CREATE TABLE "indexed"."gov_proposals" (
    "proposalId" BIGINT NOT NULL,
    "groupPolicyAddress" TEXT NOT NULL,
    "groupId" BIGINT NOT NULL,
    "proposers" TEXT[],
    "status" TEXT NOT NULL,
    "executorResult" TEXT NOT NULL,
    "metadata" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "messages" JSONB NOT NULL,
    "submitTime" TIMESTAMP(3) NOT NULL,
    "votingPeriodEnd" TIMESTAMP(3) NOT NULL,
    "yesCount" DECIMAL(39,0) NOT NULL,
    "noCount" DECIMAL(39,0) NOT NULL,
    "abstainCount" DECIMAL(39,0) NOT NULL,
    "noWithVetoCount" DECIMAL(39,0) NOT NULL,
    "groupVersion" BIGINT NOT NULL,
    "groupPolicyVersion" BIGINT NOT NULL,
    "decisionPolicy" JSONB NOT NULL,
    "observedHeight" BIGINT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "height" BIGINT,
    "txhash" TEXT,
    "prunedAtHeight" BIGINT,

    CONSTRAINT "gov_proposals_pkey" PRIMARY KEY ("proposalId")
);

-- CreateTable
CREATE TABLE "indexed"."gov_votes" (
    "proposalId" BIGINT NOT NULL,
    "voter" TEXT NOT NULL,
    "option" TEXT NOT NULL,
    "metadata" TEXT,
    "submitTime" TIMESTAMP(3) NOT NULL,
    "weight" DECIMAL(39,0),
    "height" BIGINT,
    "txhash" TEXT,

    CONSTRAINT "gov_votes_pkey" PRIMARY KEY ("proposalId","voter")
);

-- CreateTable
CREATE TABLE "indexed"."incidents" (
    "id" BIGSERIAL NOT NULL,
    "kind" "indexed"."IncidentKind" NOT NULL,
    "severity" "indexed"."IncidentSeverity" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "openedHeight" BIGINT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexed"."indexer_checkpoints" (
    "stream" TEXT NOT NULL,
    "cursorHeight" BIGINT NOT NULL,
    "cursorPage" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexer_checkpoints_pkey" PRIMARY KEY ("stream")
);

-- CreateTable
CREATE TABLE "indexed"."market_samples" (
    "id" BIGSERIAL NOT NULL,
    "venue" TEXT NOT NULL,
    "pool" TEXT NOT NULL,
    "price" DECIMAL(39,0) NOT NULL,
    "depthBands" JSONB NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexed"."operator_payments" (
    "txhash" TEXT NOT NULL,
    "msgIndex" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "valoper" TEXT NOT NULL,
    "payer" TEXT NOT NULL,
    "paymentType" "indexed"."OperatorPaymentType" NOT NULL,
    "amount" DECIMAL(39,0) NOT NULL,
    "epochIndex" BIGINT,
    "height" BIGINT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operator_payments_pkey" PRIMARY KEY ("txhash","msgIndex","ordinal")
);

-- CreateTable
CREATE TABLE "indexed"."reconciler_runs" (
    "id" BIGSERIAL NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL,
    "chainHeight" BIGINT NOT NULL,
    "indexedHeight" BIGINT NOT NULL,
    "deltas" JSONB NOT NULL,
    "withinTolerance" BOOLEAN NOT NULL,
    "incidentId" BIGINT,

    CONSTRAINT "reconciler_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexed"."redemption_requests" (
    "requestId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "shares" DECIMAL(39,0) NOT NULL,
    "estimates" JSONB,
    "status" "indexed"."RedemptionStatus" NOT NULL,
    "enqueuedAt" TIMESTAMP(3) NOT NULL,
    "expeditedAt" TIMESTAMP(3),
    "maturedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "lastHeight" BIGINT NOT NULL,
    "lastTxhash" TEXT NOT NULL,

    CONSTRAINT "redemption_requests_pkey" PRIMARY KEY ("requestId")
);

-- CreateTable
CREATE TABLE "indexed"."transactions" (
    "txhash" TEXT NOT NULL,
    "msgIndex" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "kind" "indexed"."TransactionKind" NOT NULL,
    "shares" DECIMAL(39,0) NOT NULL,
    "nhash" DECIMAL(39,0) NOT NULL,
    "navAtHeight" DECIMAL(39,0) NOT NULL,
    "height" BIGINT NOT NULL,
    "blockTime" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("txhash","msgIndex")
);

-- CreateTable
CREATE TABLE "indexed"."validator_epochs" (
    "valoper" TEXT NOT NULL,
    "epochIndex" BIGINT NOT NULL,
    "uptimeBps" INTEGER NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "failingReasons" TEXT[],
    "tip" DECIMAL(39,0) NOT NULL,
    "commissionAccrued" DECIMAL(39,0) NOT NULL,
    "commissionPaid" DECIMAL(39,0) NOT NULL,
    "commissionDue" DECIMAL(39,0) NOT NULL,
    "programDelegation" DECIMAL(39,0) NOT NULL,
    "jailedEvents" JSONB,
    "height" BIGINT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "validator_epochs_pkey" PRIMARY KEY ("valoper","epochIndex")
);

-- CreateTable
CREATE TABLE "indexed"."validator_registry" (
    "valoper" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "moniker" TEXT NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL,
    "unregisteredAt" TIMESTAMP(3),

    CONSTRAINT "validator_registry_pkey" PRIMARY KEY ("valoper")
);

-- CreateIndex
CREATE INDEX "bridge_supply_samples_sampledAt_idx" ON "indexed"."bridge_supply_samples"("sampledAt");

-- CreateIndex
CREATE INDEX "gov_proposals_groupPolicyAddress_idx" ON "indexed"."gov_proposals"("groupPolicyAddress");

-- CreateIndex
CREATE INDEX "gov_proposals_groupPolicyAddress_proposalId_idx" ON "indexed"."gov_proposals"("groupPolicyAddress", "proposalId");

-- CreateIndex
CREATE INDEX "gov_votes_voter_idx" ON "indexed"."gov_votes"("voter");

-- CreateIndex
CREATE INDEX "incidents_kind_idx" ON "indexed"."incidents"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "incidents_kind_dedupeKey_key" ON "indexed"."incidents"("kind", "dedupeKey");

-- CreateIndex
CREATE INDEX "market_samples_sampledAt_idx" ON "indexed"."market_samples"("sampledAt");

-- CreateIndex
CREATE INDEX "operator_payments_valoper_height_msgIndex_ordinal_idx" ON "indexed"."operator_payments"("valoper", "height", "msgIndex", "ordinal");

-- CreateIndex
CREATE INDEX "reconciler_runs_ranAt_idx" ON "indexed"."reconciler_runs"("ranAt");

-- CreateIndex
CREATE INDEX "redemption_requests_owner_idx" ON "indexed"."redemption_requests"("owner");

-- CreateIndex
CREATE INDEX "redemption_requests_status_idx" ON "indexed"."redemption_requests"("status");

-- CreateIndex
CREATE INDEX "redemption_requests_maturedAt_idx" ON "indexed"."redemption_requests"("maturedAt");

-- CreateIndex
CREATE INDEX "redemption_requests_expeditedAt_idx" ON "indexed"."redemption_requests"("expeditedAt");

-- CreateIndex
CREATE INDEX "redemption_requests_lastHeight_idx" ON "indexed"."redemption_requests"("lastHeight");

-- CreateIndex
CREATE INDEX "transactions_address_height_msgIndex_idx" ON "indexed"."transactions"("address", "height", "msgIndex");

-- CreateIndex
CREATE INDEX "transactions_height_idx" ON "indexed"."transactions"("height");

-- CreateIndex
CREATE INDEX "validator_epochs_epochIndex_idx" ON "indexed"."validator_epochs"("epochIndex");


-- `gov_proposals.proposers` is NOT NULL. x/group requires at least one proposer
-- and makes each one a required signer, and the generated client types the list
-- as required — a null array would be unreadable through it. A list field's
-- column nullability is not expressible in the Prisma datamodel, so the
-- constraint is asserted here.
ALTER TABLE "indexed"."gov_proposals" ALTER COLUMN "proposers" SET NOT NULL;
