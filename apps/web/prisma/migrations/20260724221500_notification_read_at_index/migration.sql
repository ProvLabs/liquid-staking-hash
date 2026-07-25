-- M6.2 PR review (round 1): the retention sweep's read-cutoff arm
-- (`readAt < cutoff`) scans globally — no address filter — which the
-- (address, readAt) composite cannot serve (address is its leading column).
-- Pair the deliveredAt index with a readAt index so the sweep's OR resolves
-- as two index arms (BitmapOr) instead of a table scan as the log grows.
-- Index-only: no column change, allowlist unaffected.

-- CreateIndex
CREATE INDEX "notifications_readAt_idx" ON "app"."notifications"("readAt");
