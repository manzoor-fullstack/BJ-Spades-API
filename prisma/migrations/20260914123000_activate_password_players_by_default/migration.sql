-- Password registrations are active immediately. Backfill accounts created by
-- the earlier email-verification flow so they follow the same policy.
UPDATE "User" AS u
SET
  "status" = 'ACTIVE',
  "emailVerified" = true,
  "emailVerifiedAt" = COALESCE(u."emailVerifiedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE
  u."status" = 'PENDING'
  AND EXISTS (
    SELECT 1
    FROM "PlayerCredential" AS credential
    WHERE credential."userId" = u."id"
  );
