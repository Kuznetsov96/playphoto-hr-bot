DROP INDEX IF EXISTS "ReplacementRequest_workShiftId_status_key";

CREATE UNIQUE INDEX "ReplacementRequest_active_workShiftId_key"
ON "ReplacementRequest"("workShiftId")
WHERE "status" = 'ACTIVE' AND "workShiftId" IS NOT NULL;

CREATE UNIQUE INDEX "ReplacementRequest_active_requester_location_date_key"
ON "ReplacementRequest"("requesterStaffId", "locationId", "shiftDate")
WHERE "status" = 'ACTIVE' AND "requesterStaffId" IS NOT NULL;

CREATE UNIQUE INDEX "ReplacementRequest_active_manual_location_date_key"
ON "ReplacementRequest"("locationId", "shiftDate")
WHERE "status" = 'ACTIVE' AND "workShiftId" IS NULL;
