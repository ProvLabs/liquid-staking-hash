-- CreateEnum
CREATE TYPE "IncidentKind" AS ENUM ('contract_halted', 'vault_paused', 'slash_write_down', 'redemption_refund', 'jail_report', 'epoch_overdue', 'reconciler_divergence', 'indexer_lag');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('info', 'warning', 'critical');

-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('enqueued', 'expedited', 'matured', 'refunded');

-- CreateEnum
CREATE TYPE "TransactionKind" AS ENUM ('swap_in', 'swap_out_request', 'redemption_payout', 'redemption_refund', 'transfer_in', 'transfer_out');

-- CreateTable
CREATE TABLE "bridge_supply_samples" (
    "id" BIGSERIAL NOT NULL,
    "chain" TEXT NOT NULL,
    "remoteSupply" DECIMAL(39,0) NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bridge_supply_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "epoch_snapshots" (
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
CREATE TABLE "gov_proposals" (
    "proposalId" BIGINT NOT NULL,
    "groupPolicyAddress" TEXT NOT NULL,
    "proposer" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "metadata" TEXT,
    "messages" JSONB NOT NULL,
    "submitTime" TIMESTAMP(3) NOT NULL,
    "height" BIGINT NOT NULL,
    "txhash" TEXT NOT NULL,

    CONSTRAINT "gov_proposals_pkey" PRIMARY KEY ("proposalId")
);

-- CreateTable
CREATE TABLE "gov_votes" (
    "proposalId" BIGINT NOT NULL,
    "voter" TEXT NOT NULL,
    "option" TEXT NOT NULL,
    "submitTime" TIMESTAMP(3) NOT NULL,
    "height" BIGINT NOT NULL,
    "txhash" TEXT NOT NULL,

    CONSTRAINT "gov_votes_pkey" PRIMARY KEY ("proposalId","voter")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" BIGSERIAL NOT NULL,
    "kind" "IncidentKind" NOT NULL,
    "severity" "IncidentSeverity" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "openedHeight" BIGINT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexer_checkpoints" (
    "stream" TEXT NOT NULL,
    "cursorHeight" BIGINT NOT NULL,
    "cursorPage" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexer_checkpoints_pkey" PRIMARY KEY ("stream")
);

-- CreateTable
CREATE TABLE "market_samples" (
    "id" BIGSERIAL NOT NULL,
    "venue" TEXT NOT NULL,
    "pool" TEXT NOT NULL,
    "price" DECIMAL(39,0) NOT NULL,
    "depthBands" JSONB NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciler_runs" (
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
CREATE TABLE "redemption_requests" (
    "requestId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "shares" DECIMAL(39,0) NOT NULL,
    "estimates" JSONB,
    "status" "RedemptionStatus" NOT NULL,
    "enqueuedAt" TIMESTAMP(3) NOT NULL,
    "expeditedAt" TIMESTAMP(3),
    "maturedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "lastHeight" BIGINT NOT NULL,
    "lastTxhash" TEXT NOT NULL,

    CONSTRAINT "redemption_requests_pkey" PRIMARY KEY ("requestId")
);

-- CreateTable
CREATE TABLE "transactions" (
    "txhash" TEXT NOT NULL,
    "msgIndex" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "kind" "TransactionKind" NOT NULL,
    "shares" DECIMAL(39,0) NOT NULL,
    "nhash" DECIMAL(39,0) NOT NULL,
    "navAtHeight" DECIMAL(39,0) NOT NULL,
    "height" BIGINT NOT NULL,
    "blockTime" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("txhash","msgIndex")
);

-- CreateTable
CREATE TABLE "validator_epochs" (
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
CREATE TABLE "validator_registry" (
    "valoper" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "moniker" TEXT NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL,
    "unregisteredAt" TIMESTAMP(3),

    CONSTRAINT "validator_registry_pkey" PRIMARY KEY ("valoper")
);

-- CreateIndex
CREATE INDEX "bridge_supply_samples_sampledAt_idx" ON "bridge_supply_samples"("sampledAt");

-- CreateIndex
CREATE INDEX "gov_proposals_groupPolicyAddress_idx" ON "gov_proposals"("groupPolicyAddress");

-- CreateIndex
CREATE INDEX "gov_votes_voter_idx" ON "gov_votes"("voter");

-- CreateIndex
CREATE INDEX "incidents_kind_idx" ON "incidents"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "incidents_kind_dedupeKey_key" ON "incidents"("kind", "dedupeKey");

-- CreateIndex
CREATE INDEX "market_samples_sampledAt_idx" ON "market_samples"("sampledAt");

-- CreateIndex
CREATE INDEX "reconciler_runs_ranAt_idx" ON "reconciler_runs"("ranAt");

-- CreateIndex
CREATE INDEX "redemption_requests_owner_idx" ON "redemption_requests"("owner");

-- CreateIndex
CREATE INDEX "redemption_requests_status_idx" ON "redemption_requests"("status");

-- CreateIndex
CREATE INDEX "transactions_address_idx" ON "transactions"("address");

-- CreateIndex
CREATE INDEX "transactions_height_idx" ON "transactions"("height");

-- CreateIndex
CREATE INDEX "validator_epochs_epochIndex_idx" ON "validator_epochs"("epochIndex");
