-- Phase 1.4 — extend the User model.
--
-- Adds the fields the create-user modal and the registration webhook already
-- collect (tier + shipping address), the INACTIVE/PENDING statuses the users
-- page filter expects, soft delete, and the indexes the list endpoint needs.
-- See docs/02-DATA-MODEL.md and docs/phases/PHASE-1.md step 1.4.
--
-- Non-breaking: every new column is nullable or has a default.

CREATE TYPE "UserTier" AS ENUM ('PLAYER', 'PREMIUM', 'VIP');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UserStatus" ADD VALUE 'INACTIVE';
ALTER TYPE "UserStatus" ADD VALUE 'PENDING';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "addressLine1" TEXT,
ADD COLUMN     "addressLine2" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "lastActiveAt" TIMESTAMP(3),
ADD COLUMN     "postalCode" TEXT,
ADD COLUMN     "state" TEXT,
ADD COLUMN     "tier" "UserTier" NOT NULL DEFAULT 'PLAYER',
ALTER COLUMN "balance" SET DATA TYPE DECIMAL(18,2);

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE INDEX "User_tier_idx" ON "User"("tier");

-- CreateIndex
CREATE INDEX "User_source_idx" ON "User"("source");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");

-- CreateIndex
CREATE INDEX "User_email_status_idx" ON "User"("email", "status");

