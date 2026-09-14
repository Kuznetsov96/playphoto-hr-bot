-- AlterTable
ALTER TABLE "ReplacementRequest" ADD COLUMN     "isManual" BOOLEAN NOT NULL DEFAULT false;

UPDATE "ReplacementRequest" SET "isManual" = true WHERE "workShiftId" IS NULL;
