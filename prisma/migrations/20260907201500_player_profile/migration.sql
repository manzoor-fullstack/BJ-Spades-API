CREATE TABLE "PlayerProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" VARCHAR(60) NOT NULL,
    "tagline" VARCHAR(100),
    "bio" VARCHAR(300),
    "dateOfBirth" DATE,
    "location" VARCHAR(120),
    "avatarName" VARCHAR(40) NOT NULL DEFAULT 'Poppa Cool',
    "avatarBackground" VARCHAR(7) NOT NULL DEFAULT '#fbbf24',
    "avatarImageId" TEXT,
    "twitter" VARCHAR(200),
    "facebook" VARCHAR(200),
    "instagram" VARCHAR(200),
    "youtube" VARCHAR(200),
    "twitch" VARCHAR(200),
    "discord" VARCHAR(200),
    "website" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlayerProfile_userId_key" ON "PlayerProfile"("userId");
CREATE UNIQUE INDEX "PlayerProfile_avatarImageId_key" ON "PlayerProfile"("avatarImageId");

ALTER TABLE "PlayerProfile" ADD CONSTRAINT "PlayerProfile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlayerProfile" ADD CONSTRAINT "PlayerProfile_avatarImageId_fkey"
  FOREIGN KEY ("avatarImageId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
