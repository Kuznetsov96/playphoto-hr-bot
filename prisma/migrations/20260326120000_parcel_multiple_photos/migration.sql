-- Migrate contentPhotoId (single) to contentPhotoIds (array)
-- Preserves existing data by wrapping non-null values in an array

ALTER TABLE "Parcel" ADD COLUMN "contentPhotoIds" TEXT[] NOT NULL DEFAULT '{}';

UPDATE "Parcel" SET "contentPhotoIds" = ARRAY["contentPhotoId"] WHERE "contentPhotoId" IS NOT NULL;

ALTER TABLE "Parcel" DROP COLUMN "contentPhotoId";
