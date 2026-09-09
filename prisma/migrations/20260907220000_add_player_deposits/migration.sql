CREATE TYPE "DepositStatus" AS ENUM (
  'CREATED', 'CHECKOUT_CREATED', 'PROCESSING', 'SUCCEEDED', 'FAILED',
  'CANCELED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED'
);

ALTER TABLE "User" ADD COLUMN "stripeCustomerId" TEXT;

CREATE TABLE "Deposit" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" "DepositStatus" NOT NULL DEFAULT 'CREATED',
  "stripeCheckoutSessionId" TEXT,
  "stripeCheckoutUrl" TEXT,
  "stripePaymentIntentId" TEXT,
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "refundedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "disputedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "creditedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "canceledAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlayerPaymentMethod" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "stripePaymentMethodId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "brand" TEXT,
  "last4" TEXT,
  "expMonth" INTEGER,
  "expYear" INTEGER,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlayerPaymentMethod_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");
CREATE UNIQUE INDEX "Deposit_stripeCheckoutSessionId_key" ON "Deposit"("stripeCheckoutSessionId");
CREATE UNIQUE INDEX "Deposit_stripePaymentIntentId_key" ON "Deposit"("stripePaymentIntentId");
CREATE UNIQUE INDEX "Deposit_userId_requestId_key" ON "Deposit"("userId", "requestId");
CREATE INDEX "Deposit_userId_createdAt_idx" ON "Deposit"("userId", "createdAt");
CREATE INDEX "Deposit_status_updatedAt_idx" ON "Deposit"("status", "updatedAt");
CREATE UNIQUE INDEX "PlayerPaymentMethod_stripePaymentMethodId_key" ON "PlayerPaymentMethod"("stripePaymentMethodId");
CREATE INDEX "PlayerPaymentMethod_userId_createdAt_idx" ON "PlayerPaymentMethod"("userId", "createdAt");

ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlayerPaymentMethod" ADD CONSTRAINT "PlayerPaymentMethod_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
