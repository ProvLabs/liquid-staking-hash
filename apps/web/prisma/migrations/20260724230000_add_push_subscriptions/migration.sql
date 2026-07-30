-- Web Push channel: the opt-in, per-browser push
-- subscription store — the ONE accepted SECURITY.md exception (opaque,
-- revocable tokens, deleted on opt-out/session removal). In the `app` schema
-- (ADR-001 Decision 1), schema-qualified to land unambiguously in `app`
-- regardless of search_path. The column set is gated by
-- test/app-schema-allowlist.test.ts (the data-minimization design review).

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

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "app"."push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_address_idx" ON "app"."push_subscriptions"("address");

-- CreateIndex
CREATE INDEX "push_subscriptions_sessionId_idx" ON "app"."push_subscriptions"("sessionId");
