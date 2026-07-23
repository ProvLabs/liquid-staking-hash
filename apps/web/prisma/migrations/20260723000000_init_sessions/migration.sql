-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "app";

-- CreateTable
CREATE TABLE "app"."address_activity" (
    "address" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "address_activity_pkey" PRIMARY KEY ("address")
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
CREATE INDEX "session_nonces_expiresAt_idx" ON "app"."session_nonces"("expiresAt");

-- CreateIndex
CREATE INDEX "sessions_address_idx" ON "app"."sessions"("address");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "app"."sessions"("expiresAt");

