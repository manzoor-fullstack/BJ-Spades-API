CREATE TYPE "GameMatchStatus" AS ENUM ('BIDDING', 'PLAYING', 'COMPLETED', 'FORFEITED', 'CANCELLED');
CREATE TYPE "GameCommandType" AS ENUM ('BID', 'PLAY_CARD', 'CLAIM_TIMEOUT', 'FORFEIT');
CREATE TYPE "GameEventType" AS ENUM ('MATCH_CREATED', 'BID_PLACED', 'CARD_PLAYED', 'TRICK_COMPLETED', 'HAND_COMPLETED', 'MATCH_COMPLETED', 'TURN_TIMED_OUT', 'PLAYER_FORFEITED');

CREATE TABLE "GameMatch" (
  "id" TEXT NOT NULL,
  "status" "GameMatchStatus" NOT NULL DEFAULT 'BIDDING',
  "rulesVersion" VARCHAR(60) NOT NULL,
  "creationRequestId" VARCHAR(80) NOT NULL,
  "createdByPlayerId" TEXT NOT NULL,
  "tournamentId" TEXT,
  "state" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "handNumber" INTEGER NOT NULL DEFAULT 1,
  "dealerSeat" INTEGER NOT NULL,
  "currentSeat" INTEGER,
  "winnerTeam" INTEGER,
  "actionDeadlineAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GameMatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GameMatch_dealerSeat_check" CHECK ("dealerSeat" BETWEEN 0 AND 3),
  CONSTRAINT "GameMatch_currentSeat_check" CHECK ("currentSeat" IS NULL OR "currentSeat" BETWEEN 0 AND 3),
  CONSTRAINT "GameMatch_winnerTeam_check" CHECK ("winnerTeam" IS NULL OR "winnerTeam" BETWEEN 0 AND 1)
);

CREATE TABLE "GameSeat" (
  "id" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "seat" INTEGER NOT NULL,
  "team" INTEGER NOT NULL,
  "entryTokenHash" VARCHAR(64),
  "entryTokenExpiresAt" TIMESTAMP(3),
  "joinedAt" TIMESTAMP(3),
  "revealedHandNumber" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GameSeat_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GameSeat_seat_check" CHECK ("seat" BETWEEN 0 AND 3),
  CONSTRAINT "GameSeat_team_check" CHECK ("team" BETWEEN 0 AND 1),
  CONSTRAINT "GameSeat_partnership_check" CHECK ("team" = MOD("seat", 2))
);

CREATE TABLE "GameCommand" (
  "id" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "idempotencyKey" VARCHAR(80) NOT NULL,
  "expectedVersion" INTEGER NOT NULL,
  "resultVersion" INTEGER NOT NULL,
  "type" "GameCommandType" NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GameCommand_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GameEvent" (
  "id" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" "GameEventType" NOT NULL,
  "actorUserId" TEXT,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GameEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GameMatch_createdByPlayerId_creationRequestId_key" ON "GameMatch"("createdByPlayerId", "creationRequestId");
CREATE INDEX "GameMatch_status_updatedAt_idx" ON "GameMatch"("status", "updatedAt");
CREATE INDEX "GameMatch_tournamentId_status_idx" ON "GameMatch"("tournamentId", "status");
CREATE UNIQUE INDEX "GameSeat_matchId_seat_key" ON "GameSeat"("matchId", "seat");
CREATE UNIQUE INDEX "GameSeat_matchId_userId_key" ON "GameSeat"("matchId", "userId");
CREATE INDEX "GameSeat_userId_createdAt_idx" ON "GameSeat"("userId", "createdAt");
CREATE UNIQUE INDEX "GameCommand_matchId_userId_idempotencyKey_key" ON "GameCommand"("matchId", "userId", "idempotencyKey");
CREATE INDEX "GameCommand_matchId_resultVersion_idx" ON "GameCommand"("matchId", "resultVersion");
CREATE INDEX "GameCommand_userId_createdAt_idx" ON "GameCommand"("userId", "createdAt");
CREATE UNIQUE INDEX "GameEvent_matchId_sequence_key" ON "GameEvent"("matchId", "sequence");
CREATE INDEX "GameEvent_matchId_createdAt_idx" ON "GameEvent"("matchId", "createdAt");
CREATE INDEX "GameEvent_actorUserId_createdAt_idx" ON "GameEvent"("actorUserId", "createdAt");

ALTER TABLE "GameMatch" ADD CONSTRAINT "GameMatch_createdByPlayerId_fkey" FOREIGN KEY ("createdByPlayerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GameMatch" ADD CONSTRAINT "GameMatch_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GameSeat" ADD CONSTRAINT "GameSeat_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "GameMatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GameSeat" ADD CONSTRAINT "GameSeat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GameCommand" ADD CONSTRAINT "GameCommand_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "GameMatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GameCommand" ADD CONSTRAINT "GameCommand_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GameEvent" ADD CONSTRAINT "GameEvent_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "GameMatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GameEvent" ADD CONSTRAINT "GameEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
