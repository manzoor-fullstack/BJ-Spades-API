-- AlterTable
ALTER TABLE "Admin" ADD COLUMN     "avatarId" TEXT;

-- AddForeignKey
ALTER TABLE "Admin" ADD CONSTRAINT "Admin_avatarId_fkey" FOREIGN KEY ("avatarId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
