CREATE TYPE "TournamentVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

ALTER TABLE "Tournament"
  ADD COLUMN "visibility" "TournamentVisibility" NOT NULL DEFAULT 'PUBLIC',
  ADD COLUMN "isFeatured" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "featuredSubtitle" TEXT,
  ADD COLUMN "xpMultiplier" DECIMAL(4,2) NOT NULL DEFAULT 1,
  ADD COLUMN "featuredRewards" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "createdByPlayerId" TEXT,
  ALTER COLUMN "createdByAdminId" DROP NOT NULL;

ALTER TABLE "Tournament"
  ADD CONSTRAINT "Tournament_createdByPlayerId_fkey"
  FOREIGN KEY ("createdByPlayerId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Tournament"
  ADD CONSTRAINT "Tournament_exactly_one_creator_check"
  CHECK (num_nonnulls("createdByAdminId", "createdByPlayerId") = 1);

CREATE INDEX "Tournament_visibility_status_startsAt_idx"
  ON "Tournament"("visibility", "status", "startsAt");
CREATE INDEX "Tournament_createdByPlayerId_startsAt_idx"
  ON "Tournament"("createdByPlayerId", "startsAt");
