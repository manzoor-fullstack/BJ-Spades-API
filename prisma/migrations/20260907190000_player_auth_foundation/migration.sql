ALTER TYPE "UserSource" ADD VALUE IF NOT EXISTS 'PLAYER';

CREATE TYPE "PlayerEmailTokenPurpose" AS ENUM ('VERIFY_EMAIL', 'PASSWORD_RESET');
CREATE TYPE "PlayerAuthProvider" AS ENUM ('GOOGLE', 'GITHUB');

CREATE TABLE "PlayerCredential" (
  "userId" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "passwordHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlayerCredential_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "PlayerSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "rememberMe" BOOLEAN NOT NULL DEFAULT false,
  "device" TEXT,
  "browser" TEXT,
  "os" TEXT,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "lastActivity" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlayerSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlayerRefreshToken" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "replacedByTokenId" TEXT,
  "createdByIp" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlayerRefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlayerEmailToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "purpose" "PlayerEmailTokenPurpose" NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlayerEmailToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlayerOAuthAccount" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" "PlayerAuthProvider" NOT NULL,
  "providerUserId" TEXT NOT NULL,
  "emailAtLink" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlayerOAuthAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlayerOAuthState" (
  "id" TEXT NOT NULL,
  "stateHash" TEXT NOT NULL,
  "provider" "PlayerAuthProvider" NOT NULL,
  "codeVerifier" TEXT NOT NULL,
  "rememberMe" BOOLEAN NOT NULL DEFAULT false,
  "redirectPath" TEXT NOT NULL DEFAULT '/',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlayerOAuthState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlayerCredential_username_key" ON "PlayerCredential"("username");
CREATE INDEX "PlayerSession_userId_isActive_idx" ON "PlayerSession"("userId", "isActive");
CREATE INDEX "PlayerSession_expiresAt_idx" ON "PlayerSession"("expiresAt");
CREATE UNIQUE INDEX "PlayerRefreshToken_tokenHash_key" ON "PlayerRefreshToken"("tokenHash");
CREATE INDEX "PlayerRefreshToken_sessionId_idx" ON "PlayerRefreshToken"("sessionId");
CREATE INDEX "PlayerRefreshToken_userId_revokedAt_idx" ON "PlayerRefreshToken"("userId", "revokedAt");
CREATE INDEX "PlayerRefreshToken_expiresAt_idx" ON "PlayerRefreshToken"("expiresAt");
CREATE UNIQUE INDEX "PlayerEmailToken_tokenHash_key" ON "PlayerEmailToken"("tokenHash");
CREATE INDEX "PlayerEmailToken_userId_purpose_consumedAt_idx" ON "PlayerEmailToken"("userId", "purpose", "consumedAt");
CREATE INDEX "PlayerEmailToken_expiresAt_idx" ON "PlayerEmailToken"("expiresAt");
CREATE UNIQUE INDEX "PlayerOAuthAccount_provider_providerUserId_key" ON "PlayerOAuthAccount"("provider", "providerUserId");
CREATE INDEX "PlayerOAuthAccount_userId_idx" ON "PlayerOAuthAccount"("userId");
CREATE UNIQUE INDEX "PlayerOAuthState_stateHash_key" ON "PlayerOAuthState"("stateHash");
CREATE INDEX "PlayerOAuthState_expiresAt_idx" ON "PlayerOAuthState"("expiresAt");

ALTER TABLE "PlayerCredential" ADD CONSTRAINT "PlayerCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayerSession" ADD CONSTRAINT "PlayerSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayerRefreshToken" ADD CONSTRAINT "PlayerRefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PlayerSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayerRefreshToken" ADD CONSTRAINT "PlayerRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayerEmailToken" ADD CONSTRAINT "PlayerEmailToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayerOAuthAccount" ADD CONSTRAINT "PlayerOAuthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
