-- Height-cursor index for the M6.2 notifier alert-facts read (app plan
-- 6.2 commit A): `/internal/alert-facts/redemptions` selects
-- `lastHeight > since_height` ascending each tick. Index-only change; no
-- column added (schema-allowlist unaffected), rebuildable from chain.

-- CreateIndex
CREATE INDEX "redemption_requests_lastHeight_idx" ON "redemption_requests"("lastHeight");
