-- AlterTable
ALTER TABLE "Role" ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "isSystem" BOOLEAN NOT NULL DEFAULT false;
