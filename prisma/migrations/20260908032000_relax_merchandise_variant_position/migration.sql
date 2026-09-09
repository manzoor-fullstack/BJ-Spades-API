DROP INDEX "MerchandiseVariant_merchandiseId_position_key";
CREATE INDEX "MerchandiseVariant_merchandiseId_position_idx"
  ON "MerchandiseVariant"("merchandiseId", "position");
