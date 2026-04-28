ALTER TABLE "StaffProfile"
ADD COLUMN "deactivatedAt" TIMESTAMP(3),
ADD COLUMN "deactivatedBy" TEXT,
ADD COLUMN "deactivatedSource" TEXT,
ADD COLUMN "deactivatedReason" TEXT;
