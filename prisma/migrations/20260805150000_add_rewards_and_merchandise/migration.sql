-- Phase 5 — rewards and merchandise.
--
-- Non-breaking: adds Reward, Merchandise, MerchandiseVariant and two enums.
--
-- Reward.value is a display STRING on purpose (D-17): the existing data mixes
-- currency with token counts, so a numeric column would need a unit enum and a
-- UI change that is not in Milestone 1. Merchandise.price IS numeric, because
-- it is only ever money.

CREATE TYPE "ItemStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'COMING_SOON');

-- CreateEnum
CREATE TYPE "RewardCategory" AS ENUM ('GENERAL', 'FOOD', 'ENTERTAINMENT', 'SHOPPING', 'TECH', 'TRAVEL');

-- CreateTable
CREATE TABLE "Reward" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "category" "RewardCategory" NOT NULL DEFAULT 'GENERAL',
    "value" TEXT NOT NULL,
    "description" TEXT,
    "terms" TEXT,
    "imageId" TEXT,
    "status" "ItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "stock" INTEGER,
    "redeemedCount" INTEGER NOT NULL DEFAULT 0,
    "createdByAdminId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Merchandise" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(18,2) NOT NULL,
    "imageId" TEXT,
    "status" "ItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByAdminId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Merchandise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchandiseVariant" (
    "id" TEXT NOT NULL,
    "merchandiseId" TEXT NOT NULL,
    "size" TEXT,
    "color" TEXT,
    "sku" TEXT,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchandiseVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reward_status_category_idx" ON "Reward"("status", "category");

-- CreateIndex
CREATE INDEX "Reward_deletedAt_idx" ON "Reward"("deletedAt");

-- CreateIndex
CREATE INDEX "Reward_createdAt_idx" ON "Reward"("createdAt");

-- CreateIndex
CREATE INDEX "Merchandise_status_idx" ON "Merchandise"("status");

-- CreateIndex
CREATE INDEX "Merchandise_deletedAt_idx" ON "Merchandise"("deletedAt");

-- CreateIndex
CREATE INDEX "Merchandise_createdAt_idx" ON "Merchandise"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MerchandiseVariant_sku_key" ON "MerchandiseVariant"("sku");

-- CreateIndex
CREATE INDEX "MerchandiseVariant_merchandiseId_idx" ON "MerchandiseVariant"("merchandiseId");

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "Admin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Merchandise" ADD CONSTRAINT "Merchandise_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Merchandise" ADD CONSTRAINT "Merchandise_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "Admin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchandiseVariant" ADD CONSTRAINT "MerchandiseVariant_merchandiseId_fkey" FOREIGN KEY ("merchandiseId") REFERENCES "Merchandise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

