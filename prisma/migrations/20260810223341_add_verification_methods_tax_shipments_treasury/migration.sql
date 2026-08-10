-- CreateEnum
CREATE TYPE "VerificationCheckState" AS ENUM ('PENDING', 'PASSED', 'FAILED', 'NOT_REQUIRED');

-- CreateEnum
CREATE TYPE "TaxDocumentKind" AS ENUM ('W9', 'W8BEN', 'FORM_1099');

-- CreateEnum
CREATE TYPE "TaxDocumentStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('PENDING', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PayoutMethod" ADD VALUE 'ZELLE';
ALTER TYPE "PayoutMethod" ADD VALUE 'ACH';
ALTER TYPE "PayoutMethod" ADD VALUE 'VENMO';
ALTER TYPE "PayoutMethod" ADD VALUE 'CASH_APP';
ALTER TYPE "PayoutMethod" ADD VALUE 'USDC';
ALTER TYPE "PayoutMethod" ADD VALUE 'BITCOIN';
ALTER TYPE "PayoutMethod" ADD VALUE 'ETHEREUM';
ALTER TYPE "PayoutMethod" ADD VALUE 'SOLANA';

-- CreateTable
CREATE TABLE "PlayerVerification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "country" TEXT,
    "walletAddress" TEXT,
    "kycCheck" "VerificationCheckState" NOT NULL DEFAULT 'PENDING',
    "ageCheck" "VerificationCheckState" NOT NULL DEFAULT 'PENDING',
    "countryCheck" "VerificationCheckState" NOT NULL DEFAULT 'PENDING',
    "taxCheck" "VerificationCheckState" NOT NULL DEFAULT 'PENDING',
    "walletCheck" "VerificationCheckState" NOT NULL DEFAULT 'PENDING',
    "fraudCheck" "VerificationCheckState" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastCheckedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutMethodAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" "PayoutMethod" NOT NULL,
    "label" TEXT,
    "reference" TEXT NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutMethodAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxDocument" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "TaxDocumentKind" NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "mediaAssetId" TEXT,
    "status" "TaxDocumentStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "merchandiseId" TEXT NOT NULL,
    "variantId" TEXT,
    "customisation" TEXT,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'PENDING',
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreasuryWallet" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "balance" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "balanceRecordedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TreasuryWallet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlayerVerification_userId_key" ON "PlayerVerification"("userId");

-- CreateIndex
CREATE INDEX "PlayerVerification_country_idx" ON "PlayerVerification"("country");

-- CreateIndex
CREATE INDEX "PayoutMethodAccount_userId_idx" ON "PayoutMethodAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutMethodAccount_userId_method_key" ON "PayoutMethodAccount"("userId", "method");

-- CreateIndex
CREATE INDEX "TaxDocument_userId_idx" ON "TaxDocument"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TaxDocument_userId_kind_taxYear_key" ON "TaxDocument"("userId", "kind", "taxYear");

-- CreateIndex
CREATE INDEX "Shipment_status_createdAt_idx" ON "Shipment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Shipment_userId_idx" ON "Shipment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TreasuryWallet_address_key" ON "TreasuryWallet"("address");

-- AddForeignKey
ALTER TABLE "PlayerVerification" ADD CONSTRAINT "PlayerVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerVerification" ADD CONSTRAINT "PlayerVerification_lastCheckedByAdminId_fkey" FOREIGN KEY ("lastCheckedByAdminId") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutMethodAccount" ADD CONSTRAINT "PayoutMethodAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxDocument" ADD CONSTRAINT "TaxDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxDocument" ADD CONSTRAINT "TaxDocument_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_merchandiseId_fkey" FOREIGN KEY ("merchandiseId") REFERENCES "Merchandise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "MerchandiseVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;
