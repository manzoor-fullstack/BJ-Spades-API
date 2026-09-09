ALTER TABLE "MerchandiseVariant" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "merchandiseId"
      ORDER BY "createdAt" ASC, "id" ASC
    ) - 1 AS "position"
  FROM "MerchandiseVariant"
)
UPDATE "MerchandiseVariant" AS variant
SET "position" = ranked."position"
FROM ranked
WHERE variant."id" = ranked."id";

CREATE UNIQUE INDEX "MerchandiseVariant_merchandiseId_position_key"
  ON "MerchandiseVariant"("merchandiseId", "position");
