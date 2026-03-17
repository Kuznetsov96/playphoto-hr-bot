-- CreateEnum
CREATE TYPE "ParcelStatus" AS ENUM ('EXPECTED', 'IN_TRANSIT', 'ARRIVED', 'PICKUP_IN_PROGRESS', 'DELIVERED', 'VERIFYING', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN "ndaReminderSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Location" ADD COLUMN "npAddressRef" TEXT,
ADD COLUMN "npRef" TEXT;

-- AlterTable
ALTER TABLE "StaffProfile" ADD COLUMN "npPhone" TEXT;

-- CreateTable
CREATE TABLE "Parcel" (
    "id" TEXT NOT NULL,
    "ttn" TEXT NOT NULL,
    "status" "ParcelStatus" NOT NULL DEFAULT 'EXPECTED',
    "locationId" TEXT,
    "recipientPhone" TEXT,
    "description" TEXT,
    "deliveryType" TEXT NOT NULL,
    "scheduledDate" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "responsibleStaffId" TEXT,
    "rejectionCount" INTEGER NOT NULL DEFAULT 0,
    "lastRejectionAt" TIMESTAMP(3),
    "contentPhotoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Parcel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Parcel_ttn_key" ON "Parcel"("ttn");

-- CreateIndex
CREATE INDEX "Parcel_status_idx" ON "Parcel"("status");

-- CreateIndex
CREATE INDEX "Parcel_locationId_idx" ON "Parcel"("locationId");

-- AddForeignKey
ALTER TABLE "Parcel" ADD CONSTRAINT "Parcel_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Parcel" ADD CONSTRAINT "Parcel_responsibleStaffId_fkey" FOREIGN KEY ("responsibleStaffId") REFERENCES "StaffProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
