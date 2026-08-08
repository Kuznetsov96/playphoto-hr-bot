ALTER TABLE "Location"
ADD COLUMN "awsPublicId" TEXT,
ADD COLUMN "canonicalCode" TEXT;

ALTER TABLE "StaffProfile"
ADD COLUMN "awsEmployeePublicId" TEXT;

ALTER TABLE "WorkShift"
ADD COLUMN "awsScheduledShiftPublicId" TEXT;

CREATE UNIQUE INDEX "Location_awsPublicId_key" ON "Location"("awsPublicId");
CREATE UNIQUE INDEX "Location_canonicalCode_key" ON "Location"("canonicalCode");
CREATE UNIQUE INDEX "StaffProfile_awsEmployeePublicId_key" ON "StaffProfile"("awsEmployeePublicId");
CREATE UNIQUE INDEX "WorkShift_awsScheduledShiftPublicId_key" ON "WorkShift"("awsScheduledShiftPublicId");
