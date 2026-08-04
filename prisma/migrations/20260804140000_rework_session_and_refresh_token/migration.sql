-- Phase 1.1 — rework Session and RefreshToken.
--
-- BREAKING, BY DESIGN. See docs/phases/PHASE-1.md and docs/02-DATA-MODEL.md.
--
-- Why:
--   * RefreshToken.token stored the raw JWT in plaintext. A database leak handed
--     over every live session. It becomes tokenHash (SHA-256).
--   * Session had no link to a token and no revokedAt, so "log out this session"
--     had nothing to act on. Sessions now own their token rotation chain.
--
-- Both tables are truncated first: the new columns are NOT NULL and there is no
-- sensible backfill for a token hash we never stored. The only consequence is
-- that everyone is logged out once. Done deliberately at the point where the
-- only account in the database is the seeded super admin.

TRUNCATE TABLE "RefreshToken", "Session" CASCADE;

-- DropIndex
DROP INDEX "RefreshToken_token_key";

-- AlterTable
ALTER TABLE "RefreshToken" DROP COLUMN "token",
ADD COLUMN     "createdByIp" TEXT,
ADD COLUMN     "replacedByTokenId" TEXT,
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "sessionId" TEXT NOT NULL,
ADD COLUMN     "tokenHash" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "expiresAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "os" TEXT,
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "revokedBy" TEXT,
ADD COLUMN     "userAgent" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_sessionId_idx" ON "RefreshToken"("sessionId");

-- CreateIndex
CREATE INDEX "RefreshToken_adminId_revokedAt_idx" ON "RefreshToken"("adminId", "revokedAt");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- CreateIndex
CREATE INDEX "Session_adminId_isActive_idx" ON "Session"("adminId", "isActive");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
