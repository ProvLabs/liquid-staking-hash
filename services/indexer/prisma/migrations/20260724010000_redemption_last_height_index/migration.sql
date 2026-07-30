-- Height-cursor index for the notifier alert-facts read:
-- `/internal/alert-facts/redemptions` selects
-- `lastHeight > since_height` ascending each tick. Index-only change; no
-- column added (schema-allowlist unaffected), rebuildable from chain.

-- CreateIndex
CREATE INDEX "redemption_requests_lastHeight_idx" ON "redemption_requests"("lastHeight");
