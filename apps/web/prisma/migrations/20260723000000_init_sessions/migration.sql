-- Baseline DDL for the `app` domain: the entire schema in one migration,
-- generated from the `prisma/*.prisma` models. Every object is schema-qualified,
-- so it lands in `app` regardless of the connection's search_path.
--
-- Applied AS `app_writer`, the role that owns the schema and holds no grants of
-- any kind on `indexed` (ADR-001 Decision 1; infra/dev/postgres/roles.sql).
--
-- TWO BLOCKS ARE HAND-WRITTEN and must be re-applied after every regeneration:
-- the CreateSchema guard immediately below, and the partial unique index at the
-- foot of the file. `prisma migrate diff` emits neither. See apps/web/CLAUDE.md.

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

-- CreateEnum
CREATE TYPE "app"."FunnelStage" AS ENUM ('visit_learn_index', 'visit_validators', 'visit_market', 'due_diligence_depth', 'connect');

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
CREATE TABLE "app"."funnel_counters" (
    "stage" "app"."FunnelStage" NOT NULL,
    "day" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "funnel_counters_pkey" PRIMARY KEY ("stage","day")
);

-- CreateTable
CREATE TABLE "app"."incident_acks" (
    "id" BIGSERIAL NOT NULL,
    "incidentId" INTEGER NOT NULL,
    "acknowledgedBy" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unacknowledgedAt" TIMESTAMP(3),
    "note" VARCHAR(500),

    CONSTRAINT "incident_acks_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "incident_acks_incidentId_idx" ON "app"."incident_acks"("incidentId");

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


-- CreateIndex (HAND-WRITTEN — plan §4b C1 / C3)
--
-- The "one LIVE acknowledgment per (incident, admin)" rule, as a DATABASE
-- CONSTRAINT rather than an application-level "already acked?" read-then-write.
-- Prisma cannot express a partial unique index, so this statement is written by
-- hand and survives regeneration only by being re-applied.
--
-- It must be PARTIAL. A plain unique on (incidentId, acknowledgedBy) would
-- forbid re-acknowledging after a reversal, and adding `unacknowledgedAt` to a
-- plain unique would enforce nothing: Postgres treats NULLs as distinct, so two
-- live acks would both be admitted — the exact defect the constraint exists to
-- prevent. Reversal sets `unacknowledgedAt`, which drops the row out of the
-- index and frees the pair for a fresh ack while the history row remains.
CREATE UNIQUE INDEX "incident_acks_live_ack_key"
    ON "app"."incident_acks" ("incidentId", "acknowledgedBy")
    WHERE "unacknowledgedAt" IS NULL;
