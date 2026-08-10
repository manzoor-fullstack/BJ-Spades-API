-- AlterTable
ALTER TABLE "Payout" ADD COLUMN     "settledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "stripeVerifiedAt" TIMESTAMP(3);
