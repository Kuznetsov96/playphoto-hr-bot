-- Allow main-admin replacement searches for empty location days without a requester shift.
ALTER TABLE "ReplacementRequest"
ALTER COLUMN "requesterStaffId" DROP NOT NULL;
