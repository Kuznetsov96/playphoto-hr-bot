-- CreateEnum
CREATE TYPE "ReplacementRequestStatus" AS ENUM ('ACTIVE', 'FOUND', 'CANCELLED', 'EXPIRED', 'FAILED', 'CLOSED_BY_SCHEDULE_SYNC');

-- CreateEnum
CREATE TYPE "ReplacementSearchWave" AS ENUM ('SAME_LOCATION_AVAILABLE', 'SAME_LOCATION_LIMITED', 'SAME_CITY_AVAILABLE', 'SAME_CITY_LIMITED', 'URGENT_ALL');

-- CreateEnum
CREATE TYPE "ReplacementResponseStatus" AS ENUM ('SENT', 'ACCEPTED', 'DECLINED', 'INACTIVE', 'DELIVERY_FAILED');

-- CreateEnum
CREATE TYPE "ReplacementAvailabilityKind" AS ENUM ('AVAILABLE', 'LIMITED');

-- CreateTable
CREATE TABLE "ReplacementRequest" (
    "id" TEXT NOT NULL,
    "workShiftId" TEXT,
    "requesterStaffId" TEXT NOT NULL,
    "replacementStaffId" TEXT,
    "locationId" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "shiftDate" TIMESTAMP(3) NOT NULL,
    "shiftStartTime" TIMESTAMP(3),
    "shiftEndTime" TIMESTAMP(3),
    "status" "ReplacementRequestStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentWave" "ReplacementSearchWave",
    "nextWaveAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "adminNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplacementRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplacementResponse" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "wave" "ReplacementSearchWave" NOT NULL,
    "availabilityKind" "ReplacementAvailabilityKind" NOT NULL,
    "status" "ReplacementResponseStatus" NOT NULL DEFAULT 'SENT',
    "chatId" BIGINT,
    "messageId" INTEGER,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "deliveryError" TEXT,

    CONSTRAINT "ReplacementResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReplacementRequest_status_nextWaveAt_idx" ON "ReplacementRequest"("status", "nextWaveAt");

-- CreateIndex
CREATE INDEX "ReplacementRequest_requesterStaffId_status_idx" ON "ReplacementRequest"("requesterStaffId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReplacementRequest_workShiftId_status_key" ON "ReplacementRequest"("workShiftId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReplacementResponse_requestId_staffId_key" ON "ReplacementResponse"("requestId", "staffId");

-- CreateIndex
CREATE INDEX "ReplacementResponse_requestId_status_idx" ON "ReplacementResponse"("requestId", "status");

-- CreateIndex
CREATE INDEX "ReplacementResponse_staffId_idx" ON "ReplacementResponse"("staffId");

-- AddForeignKey
ALTER TABLE "ReplacementRequest" ADD CONSTRAINT "ReplacementRequest_workShiftId_fkey" FOREIGN KEY ("workShiftId") REFERENCES "WorkShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplacementRequest" ADD CONSTRAINT "ReplacementRequest_requesterStaffId_fkey" FOREIGN KEY ("requesterStaffId") REFERENCES "StaffProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplacementRequest" ADD CONSTRAINT "ReplacementRequest_replacementStaffId_fkey" FOREIGN KEY ("replacementStaffId") REFERENCES "StaffProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplacementRequest" ADD CONSTRAINT "ReplacementRequest_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplacementResponse" ADD CONSTRAINT "ReplacementResponse_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ReplacementRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplacementResponse" ADD CONSTRAINT "ReplacementResponse_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
