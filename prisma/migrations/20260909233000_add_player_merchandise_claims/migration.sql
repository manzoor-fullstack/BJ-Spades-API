-- Player merchandise catalogue pricing and durable fulfilment claims.
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'MERCHANDISE_PURCHASE';

ALTER TABLE "Merchandise"
ADD COLUMN "tokenCost" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- Existing merchandise keeps an explicit, deterministic five-token-per-dollar
-- price until an operator chooses a different catalogue price.
UPDATE "Merchandise"
SET "tokenCost" = ROUND("price" * 5, 2)
WHERE "tokenCost" = 0;

ALTER TABLE "Shipment"
ADD COLUMN "requestId" TEXT,
ADD COLUMN "payloadHash" TEXT,
ADD COLUMN "tokenCost" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN "purchaseTransactionId" TEXT,
ADD COLUMN "refundTransactionId" TEXT,
ADD COLUMN "shippingName" TEXT NOT NULL DEFAULT '',
ADD COLUMN "addressLine1" TEXT NOT NULL DEFAULT '',
ADD COLUMN "addressLine2" TEXT,
ADD COLUMN "city" TEXT NOT NULL DEFAULT '',
ADD COLUMN "state" TEXT NOT NULL DEFAULT '',
ADD COLUMN "postalCode" TEXT NOT NULL DEFAULT '',
ADD COLUMN "country" TEXT NOT NULL DEFAULT '',
ADD COLUMN "cancelledAt" TIMESTAMP(3);

-- Snapshot the current destination for legacy rows once. Future profile edits
-- can no longer mutate the address displayed for an old shipment.
UPDATE "Shipment" AS s
SET
  "shippingName" = CONCAT_WS(' ', u."firstName", u."lastName"),
  "addressLine1" = COALESCE(u."addressLine1", ''),
  "addressLine2" = u."addressLine2",
  "city" = COALESCE(u."city", ''),
  "state" = COALESCE(u."state", ''),
  "postalCode" = COALESCE(u."postalCode", ''),
  "country" = COALESCE(u."country", '')
FROM "User" AS u
WHERE u."id" = s."userId";

CREATE UNIQUE INDEX "Shipment_purchaseTransactionId_key" ON "Shipment"("purchaseTransactionId");
CREATE UNIQUE INDEX "Shipment_refundTransactionId_key" ON "Shipment"("refundTransactionId");
CREATE UNIQUE INDEX "Shipment_userId_requestId_key" ON "Shipment"("userId", "requestId");

ALTER TABLE "Shipment"
ADD CONSTRAINT "Shipment_purchaseTransactionId_fkey"
FOREIGN KEY ("purchaseTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "Shipment_refundTransactionId_fkey"
FOREIGN KEY ("refundTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
