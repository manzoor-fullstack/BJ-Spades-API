-- Phase 2 — activity log.
--
-- Append-only audit trail of admin actions. Non-breaking: adds one table and
-- one enum, touches nothing existing.
--
-- adminId uses ON DELETE SET NULL, never CASCADE: removing an admin must not
-- erase the record of what they did.

CREATE TYPE "ActivityCategory" AS ENUM ('AUTH', 'USER', 'ADMIN', 'TOURNAMENT', 'REWARD', 'MERCHANDISE', 'PAYOUT', 'SETTINGS', 'SECURITY', 'WEBHOOK');

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "category" "ActivityCategory" NOT NULL,
    "action" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "adminId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "isHighPriority" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_category_createdAt_idx" ON "ActivityLog"("category", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_adminId_createdAt_idx" ON "ActivityLog"("adminId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_entityType_entityId_idx" ON "ActivityLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ActivityLog_isHighPriority_createdAt_idx" ON "ActivityLog"("isHighPriority", "createdAt");

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

