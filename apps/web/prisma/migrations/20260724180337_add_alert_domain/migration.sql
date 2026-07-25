-- M6.2 alert domain (app plan 6.2 commit B): preference-override rules, the
-- in-app notification log, and the notifier's per-stream checkpoints. All in
-- the `app` schema (ADR-001 Decision 1), schema-qualified to match the init
-- migration and land unambiguously in `app` regardless of search_path. The
-- column set is gated by test/app-schema-allowlist.test.ts (the
-- data-minimization design review).

-- CreateEnum
CREATE TYPE "app"."AlertKind" AS ENUM ('nav_step_posted', 'redemption_update', 'vault_status', 'validator_set_incident', 'operator_arrears');

-- CreateTable
CREATE TABLE "app"."alert_rules" (
    "address" TEXT NOT NULL,
    "kind" "app"."AlertKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("address","kind")
);

-- CreateTable
CREATE TABLE "app"."notifications" (
    "id" BIGSERIAL NOT NULL,
    "address" TEXT NOT NULL,
    "kind" "app"."AlertKind" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."notifier_checkpoints" (
    "stream" TEXT NOT NULL,
    "cursor" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifier_checkpoints_pkey" PRIMARY KEY ("stream")
);

-- CreateIndex
CREATE INDEX "notifications_address_readAt_idx" ON "app"."notifications"("address", "readAt");

-- CreateIndex
CREATE INDEX "notifications_deliveredAt_idx" ON "app"."notifications"("deliveredAt");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_address_kind_dedupeKey_key" ON "app"."notifications"("address", "kind", "dedupeKey");
