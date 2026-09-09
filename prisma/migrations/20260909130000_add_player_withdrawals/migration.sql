CREATE TYPE "WithdrawalRequestStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'DECLINED', 'CANCELLED');

ALTER TABLE "Payout" ADD COLUMN "withdrawalRequestId" TEXT;

CREATE TABLE "WithdrawalRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "destinationId" TEXT NOT NULL,
    "destinationMethod" "PayoutMethod" NOT NULL,
    "destinationLabel" TEXT,
    "destinationReference" TEXT NOT NULL,
    "status" "WithdrawalRequestStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewReason" TEXT,
    "approvedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "reservationTransactionId" TEXT NOT NULL,
    "releaseTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Payout_withdrawalRequestId_key" ON "Payout"("withdrawalRequestId");
CREATE UNIQUE INDEX "WithdrawalRequest_reservationTransactionId_key" ON "WithdrawalRequest"("reservationTransactionId");
CREATE UNIQUE INDEX "WithdrawalRequest_releaseTransactionId_key" ON "WithdrawalRequest"("releaseTransactionId");
CREATE UNIQUE INDEX "WithdrawalRequest_userId_requestId_key" ON "WithdrawalRequest"("userId", "requestId");
CREATE INDEX "WithdrawalRequest_userId_createdAt_idx" ON "WithdrawalRequest"("userId", "createdAt");
CREATE INDEX "WithdrawalRequest_status_createdAt_idx" ON "WithdrawalRequest"("status", "createdAt");
CREATE INDEX "WithdrawalRequest_destinationId_idx" ON "WithdrawalRequest"("destinationId");

ALTER TABLE "Payout" ADD CONSTRAINT "Payout_withdrawalRequestId_fkey" FOREIGN KEY ("withdrawalRequestId") REFERENCES "WithdrawalRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "PayoutMethodAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_reservationTransactionId_fkey" FOREIGN KEY ("reservationTransactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_releaseTransactionId_fkey" FOREIGN KEY ("releaseTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
