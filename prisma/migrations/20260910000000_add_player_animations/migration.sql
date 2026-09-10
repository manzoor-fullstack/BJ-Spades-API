ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'ANIMATION_PURCHASE';

CREATE TYPE "AnimationCategory" AS ENUM ('WIN_VICTORY', 'CARD_PLAY', 'NIL', 'TRASH_TALK', 'EMOTES', 'STREAK', 'PENALTY');
CREATE TYPE "AnimationEntitlementSource" AS ENUM ('PURCHASE', 'VIP', 'ACHIEVEMENT');

CREATE TABLE "Animation" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "category" "AnimationCategory" NOT NULL,
  "price" DECIMAL(18,2) NOT NULL,
  "assetUrl" TEXT NOT NULL,
  "effectKey" TEXT NOT NULL,
  "featured" BOOLEAN NOT NULL DEFAULT false,
  "vipOnly" BOOLEAN NOT NULL DEFAULT false,
  "status" "ItemStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Animation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlayerAnimationEntitlement" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "animationId" TEXT NOT NULL,
  "source" "AnimationEntitlementSource" NOT NULL,
  "pricePaid" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "requestId" TEXT,
  "payloadHash" TEXT,
  "purchaseTransactionId" TEXT,
  "equippedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlayerAnimationEntitlement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Animation_status_category_idx" ON "Animation"("status", "category");
CREATE INDEX "Animation_featured_status_idx" ON "Animation"("featured", "status");
CREATE UNIQUE INDEX "PlayerAnimationEntitlement_purchaseTransactionId_key" ON "PlayerAnimationEntitlement"("purchaseTransactionId");
CREATE UNIQUE INDEX "PlayerAnimationEntitlement_userId_animationId_key" ON "PlayerAnimationEntitlement"("userId", "animationId");
CREATE UNIQUE INDEX "PlayerAnimationEntitlement_userId_requestId_key" ON "PlayerAnimationEntitlement"("userId", "requestId");
CREATE INDEX "PlayerAnimationEntitlement_userId_equippedAt_idx" ON "PlayerAnimationEntitlement"("userId", "equippedAt");

ALTER TABLE "PlayerAnimationEntitlement"
ADD CONSTRAINT "PlayerAnimationEntitlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "PlayerAnimationEntitlement_animationId_fkey" FOREIGN KEY ("animationId") REFERENCES "Animation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "PlayerAnimationEntitlement_purchaseTransactionId_fkey" FOREIGN KEY ("purchaseTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
