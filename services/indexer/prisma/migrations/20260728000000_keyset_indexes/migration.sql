-- Keyset-walk indexes (2026-07-28 review). INDEX-ONLY migration: no column is
-- added or removed, so the SECURITY.md schema-field allowlist is unaffected
-- (`redemption_requests.lastHeight` migration set this precedent).
--
-- Both exports (§14.11 holder and operator) walk their history by keyset on
-- `(height, msg_index)`. Measured on the dev DB at 300 000 rows for one
-- valoper: with the two-column index the walk's range bound could not enter the
-- index condition, so Postgres scanned from the start of the group and filtered
-- (9 564 buffers / 25 ms per chunk, i.e. still quadratic overall). Extending
-- each index to include the tie-break column lets the row-comparison predicate
-- `(height, msg_index) > (?, ?)` become a pure Index Cond: ~42 buffers / 0.2 ms
-- per chunk, FLAT at every depth of the walk.
--
-- Each new index has the same leading column as the one it replaces, so every
-- query the old index served is still served (verified by EXPLAIN over the
-- reader's full query set).

-- operator_payments: (valoper, height) -> (valoper, height, msgIndex)
CREATE INDEX "operator_payments_valoper_height_msgIndex_idx"
  ON "indexed"."operator_payments" ("valoper", "height", "msgIndex");
DROP INDEX "indexed"."operator_payments_valoper_height_idx";

-- transactions: (address) -> (address, height, msgIndex)
CREATE INDEX "transactions_address_height_msgIndex_idx"
  ON "indexed"."transactions" ("address", "height", "msgIndex");
DROP INDEX "indexed"."transactions_address_idx";
