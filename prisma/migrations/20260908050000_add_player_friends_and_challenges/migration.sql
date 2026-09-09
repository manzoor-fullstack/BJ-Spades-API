CREATE TYPE "PlayerFriendshipStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');
CREATE TYPE "GameChallengeStatus" AS ENUM ('PENDING', 'ACCEPTED', 'MATCHED', 'DECLINED', 'CANCELLED', 'EXPIRED');

CREATE TABLE "PlayerFriendship" (
    "id" TEXT NOT NULL,
    "playerOneId" TEXT NOT NULL,
    "playerTwoId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" "PlayerFriendshipStatus" NOT NULL DEFAULT 'PENDING',
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlayerFriendship_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlayerFriendship_distinct_players" CHECK ("playerOneId" < "playerTwoId"),
    CONSTRAINT "PlayerFriendship_requester_is_player" CHECK ("requestedById" = "playerOneId" OR "requestedById" = "playerTwoId")
);

CREATE TABLE "PlayerBlock" (
    "id" TEXT NOT NULL,
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlayerBlock_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlayerBlock_distinct_players" CHECK ("blockerId" <> "blockedId")
);

CREATE TABLE "PlayerPresence" (
    "userId" TEXT NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlayerPresence_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "GameChallenge" (
    "id" TEXT NOT NULL,
    "challengerId" TEXT NOT NULL,
    "challengedId" TEXT NOT NULL,
    "requestId" VARCHAR(80) NOT NULL,
    "status" "GameChallengeStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "matchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GameChallenge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GameChallenge_distinct_players" CHECK ("challengerId" <> "challengedId")
);

CREATE UNIQUE INDEX "PlayerFriendship_playerOneId_playerTwoId_key" ON "PlayerFriendship"("playerOneId", "playerTwoId");
CREATE INDEX "PlayerFriendship_playerOneId_status_idx" ON "PlayerFriendship"("playerOneId", "status");
CREATE INDEX "PlayerFriendship_playerTwoId_status_idx" ON "PlayerFriendship"("playerTwoId", "status");
CREATE INDEX "PlayerFriendship_requestedById_status_idx" ON "PlayerFriendship"("requestedById", "status");
CREATE UNIQUE INDEX "PlayerBlock_blockerId_blockedId_key" ON "PlayerBlock"("blockerId", "blockedId");
CREATE INDEX "PlayerBlock_blockedId_idx" ON "PlayerBlock"("blockedId");
CREATE INDEX "PlayerPresence_heartbeatAt_idx" ON "PlayerPresence"("heartbeatAt");
CREATE UNIQUE INDEX "GameChallenge_challengerId_requestId_key" ON "GameChallenge"("challengerId", "requestId");
CREATE INDEX "GameChallenge_challengedId_status_expiresAt_idx" ON "GameChallenge"("challengedId", "status", "expiresAt");
CREATE INDEX "GameChallenge_challengerId_status_expiresAt_idx" ON "GameChallenge"("challengerId", "status", "expiresAt");
CREATE INDEX "GameChallenge_status_acceptedAt_idx" ON "GameChallenge"("status", "acceptedAt");
CREATE INDEX "GameChallenge_matchId_idx" ON "GameChallenge"("matchId");

ALTER TABLE "PlayerFriendship" ADD CONSTRAINT "PlayerFriendship_playerOneId_fkey" FOREIGN KEY ("playerOneId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayerFriendship" ADD CONSTRAINT "PlayerFriendship_playerTwoId_fkey" FOREIGN KEY ("playerTwoId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayerFriendship" ADD CONSTRAINT "PlayerFriendship_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayerBlock" ADD CONSTRAINT "PlayerBlock_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayerBlock" ADD CONSTRAINT "PlayerBlock_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayerPresence" ADD CONSTRAINT "PlayerPresence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GameChallenge" ADD CONSTRAINT "GameChallenge_challengerId_fkey" FOREIGN KEY ("challengerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GameChallenge" ADD CONSTRAINT "GameChallenge_challengedId_fkey" FOREIGN KEY ("challengedId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GameChallenge" ADD CONSTRAINT "GameChallenge_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "GameMatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
