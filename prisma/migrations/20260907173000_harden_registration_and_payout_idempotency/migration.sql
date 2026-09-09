ALTER TABLE "TournamentRegistration"
ADD COLUMN "entryAttempt" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "Payout"
ADD COLUMN "tournamentResultKey" TEXT;

CREATE UNIQUE INDEX "Payout_tournamentResultKey_key"
ON "Payout"("tournamentResultKey");

ALTER TABLE "Transaction"
ADD COLUMN "affectsBalance" BOOLEAN NOT NULL DEFAULT true;
