-- Per-payment operator payment rows (App M6.4 commit A, plan §2.1). The
-- §14.11 operator CSV is per-PAYMENT (datetime, height, epoch, type, amount,
-- txhash); `validator_epochs` holds only per-epoch cumulative totals with no
-- txhash, so the facts do not exist until this table does.
--
-- Every column is public chain data read off the tx. The new columns are
-- enumerated in test/security/allowed-fields.ts (the design-review gate) —
-- adding a column is an edit there, never a migration alone.

-- CreateEnum
CREATE TYPE "OperatorPaymentType" AS ENUM ('commission', 'tip');

-- CreateTable
CREATE TABLE "operator_payments" (
    "txhash" TEXT NOT NULL,
    "msgIndex" INTEGER NOT NULL,
    "valoper" TEXT NOT NULL,
    "payer" TEXT NOT NULL,
    "paymentType" "OperatorPaymentType" NOT NULL,
    "amount" DECIMAL(39,0) NOT NULL,
    "epochIndex" BIGINT,
    "height" BIGINT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operator_payments_pkey" PRIMARY KEY ("txhash","msgIndex")
);

-- CreateIndex
CREATE INDEX "operator_payments_valoper_height_idx" ON "operator_payments"("valoper", "height");
