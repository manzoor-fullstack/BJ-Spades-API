CREATE TYPE "PlayerNotificationType" AS ENUM ('SYSTEM', 'TOURNAMENT', 'WALLET', 'REWARD', 'LEARNING', 'MEMBERSHIP');
CREATE TYPE "PlayerMembershipStatus" AS ENUM ('WAITLISTED', 'ACTIVE', 'CANCELLED', 'EXPIRED');

CREATE TABLE "PlayerNotification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "PlayerNotificationType" NOT NULL DEFAULT 'SYSTEM',
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "targetPage" TEXT,
  "targetId" TEXT,
  "eventKey" TEXT NOT NULL,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlayerNotification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlayerNotification_userId_eventKey_key" ON "PlayerNotification"("userId", "eventKey");
CREATE INDEX "PlayerNotification_userId_readAt_createdAt_idx" ON "PlayerNotification"("userId", "readAt", "createdAt");
ALTER TABLE "PlayerNotification" ADD CONSTRAINT "PlayerNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PlayerNotificationPreference" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
  "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlayerNotificationPreference_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlayerNotificationPreference_userId_key" ON "PlayerNotificationPreference"("userId");
ALTER TABLE "PlayerNotificationPreference" ADD CONSTRAINT "PlayerNotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EarlyAccessLead" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "email" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'PLAYER_APP',
  "consentAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EarlyAccessLead_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EarlyAccessLead_userId_key" ON "EarlyAccessLead"("userId");
CREATE UNIQUE INDEX "EarlyAccessLead_email_key" ON "EarlyAccessLead"("email");
ALTER TABLE "EarlyAccessLead" ADD CONSTRAINT "EarlyAccessLead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PlayerMembership" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tier" "UserTier" NOT NULL,
  "status" "PlayerMembershipStatus" NOT NULL DEFAULT 'WAITLISTED',
  "startedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlayerMembership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlayerMembership_userId_key" ON "PlayerMembership"("userId");
CREATE INDEX "PlayerMembership_status_expiresAt_idx" ON "PlayerMembership"("status", "expiresAt");
ALTER TABLE "PlayerMembership" ADD CONSTRAINT "PlayerMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
