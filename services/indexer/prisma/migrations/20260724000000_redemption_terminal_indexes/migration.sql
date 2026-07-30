-- Terminal-timestamp indexes for the §9.5.3 payout-stats query: the recent terminal cohort is filtered by expeditedAt/maturedAt
-- >= cutoff. Index-only change; no column added (schema-allowlist unaffected).

-- CreateIndex
CREATE INDEX "redemption_requests_maturedAt_idx" ON "redemption_requests"("maturedAt");

-- CreateIndex
CREATE INDEX "redemption_requests_expeditedAt_idx" ON "redemption_requests"("expeditedAt");
