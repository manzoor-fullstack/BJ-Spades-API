CREATE TYPE "TournamentTeamStatus" AS ENUM ('ACTIVE', 'ELIMINATED', 'CHAMPION', 'RUNNER_UP', 'DISQUALIFIED');
CREATE TYPE "TournamentPrizeAwardStatus" AS ENUM ('HELD', 'CREDITED', 'REVERSED');

ALTER TABLE "Tournament"
  ADD COLUMN "bracketStartedAt" TIMESTAMP(3),
  ADD COLUMN "bracketSeed" VARCHAR(64),
  ADD COLUMN "bracketRounds" INTEGER,
  ADD COLUMN "prizeRuleVersion" VARCHAR(40) NOT NULL DEFAULT 'team-70-30-v1',
  ADD COLUMN "settlementVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "settledAt" TIMESTAMP(3);

CREATE TABLE "TournamentTeam" (
  "id" TEXT NOT NULL,
  "tournamentId" TEXT NOT NULL,
  "seed" INTEGER NOT NULL,
  "status" "TournamentTeamStatus" NOT NULL DEFAULT 'ACTIVE',
  "placement" INTEGER,
  "eliminatedRound" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TournamentTeam_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TournamentTeam_seed_check" CHECK ("seed" > 0),
  CONSTRAINT "TournamentTeam_placement_check" CHECK ("placement" IS NULL OR "placement" > 0)
);

ALTER TABLE "TournamentRegistration" ADD COLUMN "teamId" TEXT;

ALTER TABLE "GameMatch"
  ADD COLUMN "tournamentRound" INTEGER,
  ADD COLUMN "tournamentSlot" INTEGER,
  ADD COLUMN "resultAppliedAt" TIMESTAMP(3);

ALTER TABLE "GameSeat" ADD COLUMN "tournamentTeamId" TEXT;

CREATE TABLE "TournamentPrizeAward" (
  "id" TEXT NOT NULL,
  "tournamentId" TEXT NOT NULL,
  "registrationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "placement" INTEGER NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "settlementVersion" INTEGER NOT NULL,
  "status" "TournamentPrizeAwardStatus" NOT NULL,
  "holdReason" TEXT,
  "correctionReason" TEXT,
  "transactionId" TEXT,
  "reversalTransactionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TournamentPrizeAward_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TournamentPrizeAward_placement_check" CHECK ("placement" > 0),
  CONSTRAINT "TournamentPrizeAward_amount_check" CHECK ("amount" >= 0),
  CONSTRAINT "TournamentPrizeAward_version_check" CHECK ("settlementVersion" > 0)
);

CREATE UNIQUE INDEX "TournamentTeam_tournamentId_seed_key" ON "TournamentTeam"("tournamentId", "seed");
CREATE INDEX "TournamentTeam_tournamentId_status_idx" ON "TournamentTeam"("tournamentId", "status");
CREATE INDEX "TournamentRegistration_teamId_idx" ON "TournamentRegistration"("teamId");
CREATE UNIQUE INDEX "GameMatch_tournamentId_tournamentRound_tournamentSlot_key" ON "GameMatch"("tournamentId", "tournamentRound", "tournamentSlot");
CREATE INDEX "GameSeat_tournamentTeamId_idx" ON "GameSeat"("tournamentTeamId");
CREATE UNIQUE INDEX "TournamentPrizeAward_transactionId_key" ON "TournamentPrizeAward"("transactionId");
CREATE UNIQUE INDEX "TournamentPrizeAward_reversalTransactionId_key" ON "TournamentPrizeAward"("reversalTransactionId");
CREATE UNIQUE INDEX "TournamentPrizeAward_tournamentId_userId_settlementVersion_key" ON "TournamentPrizeAward"("tournamentId", "userId", "settlementVersion");
CREATE INDEX "TournamentPrizeAward_tournamentId_status_idx" ON "TournamentPrizeAward"("tournamentId", "status");
CREATE INDEX "TournamentPrizeAward_userId_createdAt_idx" ON "TournamentPrizeAward"("userId", "createdAt");

ALTER TABLE "TournamentTeam" ADD CONSTRAINT "TournamentTeam_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TournamentRegistration" ADD CONSTRAINT "TournamentRegistration_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "TournamentTeam"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GameSeat" ADD CONSTRAINT "GameSeat_tournamentTeamId_fkey" FOREIGN KEY ("tournamentTeamId") REFERENCES "TournamentTeam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TournamentPrizeAward" ADD CONSTRAINT "TournamentPrizeAward_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TournamentPrizeAward" ADD CONSTRAINT "TournamentPrizeAward_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "TournamentRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TournamentPrizeAward" ADD CONSTRAINT "TournamentPrizeAward_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TournamentPrizeAward" ADD CONSTRAINT "TournamentPrizeAward_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TournamentPrizeAward" ADD CONSTRAINT "TournamentPrizeAward_reversalTransactionId_fkey" FOREIGN KEY ("reversalTransactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "TournamentResultCorrection" (
  "id" TEXT NOT NULL,
  "tournamentId" TEXT NOT NULL,
  "requestId" VARCHAR(80) NOT NULL,
  "reason" TEXT NOT NULL,
  "settlementVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TournamentResultCorrection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TournamentResultCorrection_version_check" CHECK ("settlementVersion" > 1)
);
CREATE UNIQUE INDEX "TournamentResultCorrection_tournamentId_requestId_key" ON "TournamentResultCorrection"("tournamentId", "requestId");
CREATE INDEX "TournamentResultCorrection_tournamentId_createdAt_idx" ON "TournamentResultCorrection"("tournamentId", "createdAt");
ALTER TABLE "TournamentResultCorrection" ADD CONSTRAINT "TournamentResultCorrection_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
