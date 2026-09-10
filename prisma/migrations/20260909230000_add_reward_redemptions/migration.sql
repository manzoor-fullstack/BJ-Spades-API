-- F13: player gift-card catalogue and durable redemption orders.
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'REWARD_PURCHASE';

CREATE TYPE "RewardRedemptionStatus" AS ENUM (
  'PENDING_FULFILLMENT',
  'FULFILLED',
  'REDEEMED',
  'CANCELLED',
  'REFUNDED',
  'EXPIRED'
);

CREATE TYPE "RewardDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

ALTER TABLE "Reward"
  ADD COLUMN "denomination" DECIMAL(18,2),
  ADD COLUMN "tokenCost" DECIMAL(18,2),
  ADD COLUMN "bonusPercent" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "availableFrom" TIMESTAMP(3),
  ADD COLUMN "availableUntil" TIMESTAMP(3);

CREATE TABLE "RewardRedemption" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "rewardId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "denomination" DECIMAL(18,2) NOT NULL,
  "tokenCost" DECIMAL(18,2) NOT NULL,
  "status" "RewardRedemptionStatus" NOT NULL DEFAULT 'PENDING_FULFILLMENT',
  "purchaseTransactionId" TEXT NOT NULL,
  "refundTransactionId" TEXT,
  "fulfilledAt" TIMESTAMP(3),
  "redeemedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RewardRedemption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RewardDelivery" (
  "id" TEXT NOT NULL,
  "redemptionId" TEXT NOT NULL,
  "status" "RewardDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "supplierReference" TEXT,
  "encryptedCode" TEXT,
  "failureReason" TEXT,
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RewardDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RewardRedemption_purchaseTransactionId_key" ON "RewardRedemption"("purchaseTransactionId");
CREATE UNIQUE INDEX "RewardRedemption_refundTransactionId_key" ON "RewardRedemption"("refundTransactionId");
CREATE UNIQUE INDEX "RewardRedemption_userId_requestId_key" ON "RewardRedemption"("userId", "requestId");
CREATE INDEX "RewardRedemption_userId_createdAt_idx" ON "RewardRedemption"("userId", "createdAt");
CREATE INDEX "RewardRedemption_rewardId_status_idx" ON "RewardRedemption"("rewardId", "status");
CREATE INDEX "RewardRedemption_status_createdAt_idx" ON "RewardRedemption"("status", "createdAt");
CREATE UNIQUE INDEX "RewardDelivery_redemptionId_key" ON "RewardDelivery"("redemptionId");
CREATE UNIQUE INDEX "RewardDelivery_supplierReference_key" ON "RewardDelivery"("supplierReference");
CREATE INDEX "RewardDelivery_status_createdAt_idx" ON "RewardDelivery"("status", "createdAt");

ALTER TABLE "RewardRedemption" ADD CONSTRAINT "RewardRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RewardRedemption" ADD CONSTRAINT "RewardRedemption_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "Reward"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RewardRedemption" ADD CONSTRAINT "RewardRedemption_purchaseTransactionId_fkey" FOREIGN KEY ("purchaseTransactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RewardRedemption" ADD CONSTRAINT "RewardRedemption_refundTransactionId_fkey" FOREIGN KEY ("refundTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RewardDelivery" ADD CONSTRAINT "RewardDelivery_redemptionId_fkey" FOREIGN KEY ("redemptionId") REFERENCES "RewardRedemption"("id") ON DELETE CASCADE ON UPDATE CASCADE;
