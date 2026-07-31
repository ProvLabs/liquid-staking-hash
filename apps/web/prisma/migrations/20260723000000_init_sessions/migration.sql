-- Baseline DDL for the `app` domain: the entire schema in one migration,
-- generated from the `prisma/*.prisma` models. Every object is schema-qualified,
-- so it lands in `app` regardless of the connection's search_path.
--
-- Applied AS `app_writer`, the role that owns the schema and holds no grants of
-- any kind on `indexed` (ADR-001 Decision 1; infra/dev/postgres/roles.sql).

-- CreateSchema
--
-- Guarded by an existence check rather than written `CREATE SCHEMA IF NOT
-- EXISTS`: that form still requires CREATE on the DATABASE, which `app_writer`
-- does not hold and must not be granted — it owns the schema
-- infra/dev/postgres/roles.sql created for it, nothing wider. The guard skips
-- the statement entirely there, and still creates the schema on a bare database
-- whose connecting role can.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_namespace WHERE nspname = 'app') THEN
    EXECUTE 'CREATE SCHEMA "app"';
  END IF;
END
$$;

-- CreateEnum
CREATE TYPE "app"."AlertKind" AS ENUM ('nav_step_posted', 'redemption_update', 'vault_status', 'validator_set_incident', 'operator_arrears');

-- CreateTable
CREATE TABLE "app"."address_activity" (
    "address" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "address_activity_pkey" PRIMARY KEY ("address")
);

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

-- CreateTable
CREATE TABLE "app"."push_subscriptions" (
    "id" BIGSERIAL NOT NULL,
    "address" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."session_nonces" (
    "nonce" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_nonces_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "app"."sessions" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastRefreshAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_address_readAt_idx" ON "app"."notifications"("address", "readAt");

-- CreateIndex
CREATE INDEX "notifications_deliveredAt_idx" ON "app"."notifications"("deliveredAt");

-- CreateIndex
CREATE INDEX "notifications_readAt_idx" ON "app"."notifications"("readAt");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_address_kind_dedupeKey_key" ON "app"."notifications"("address", "kind", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "app"."push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_address_idx" ON "app"."push_subscriptions"("address");

-- CreateIndex
CREATE INDEX "push_subscriptions_sessionId_idx" ON "app"."push_subscriptions"("sessionId");

-- CreateIndex
CREATE INDEX "session_nonces_expiresAt_idx" ON "app"."session_nonces"("expiresAt");

-- CreateIndex
CREATE INDEX "sessions_address_idx" ON "app"."sessions"("address");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "app"."sessions"("expiresAt");

