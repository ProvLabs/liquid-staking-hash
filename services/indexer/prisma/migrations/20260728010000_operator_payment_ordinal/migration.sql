-- Sibling discriminator for batched operator payments (PR #22 review).
--
-- `operator_payments` was keyed `(txhash, msgIndex)`. That is the right natural
-- key for ONE payment per message, which is the only shape the devnet corpus
-- carries — but a contract may legally batch several `pay_tip`/`pay_commission`
-- sub-calls into a single message, and the decoder now emits each of them. Under
-- the old key every sibling upserted onto the same row, so all but the last were
-- silently discarded: the operator's history, lifetime totals and §14.11 CSV
-- would each have shown one payment where several occurred.
--
-- `ordinal` is the payment's position within its (txhash, msgIndex), derived
-- from event order in the tx — deterministic chain data, so replay from any
-- height converges exactly as before. Existing rows are all single-payment
-- messages and take the default 0, so the backfill is a no-op and no historical
-- row changes identity.
--
-- The column is enumerated in test/security/allowed-fields.ts in the same change
-- (the design-review gate): it is an ordinal read off the tx, never user or
-- off-chain data.

ALTER TABLE "indexed"."operator_payments" ADD COLUMN "ordinal" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "indexed"."operator_payments" DROP CONSTRAINT "operator_payments_pkey";
ALTER TABLE "indexed"."operator_payments"
  ADD CONSTRAINT "operator_payments_pkey" PRIMARY KEY ("txhash", "msgIndex", "ordinal");

-- The export walks by keyset on the full sort key, so the tie-break column has
-- to be in the index or the range bound cannot enter the index condition.
CREATE INDEX "operator_payments_valoper_height_msgIndex_ordinal_idx"
  ON "indexed"."operator_payments" ("valoper", "height", "msgIndex", "ordinal");
DROP INDEX "indexed"."operator_payments_valoper_height_msgIndex_idx";
