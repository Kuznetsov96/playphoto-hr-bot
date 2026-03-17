-- Add new enum value for CandidateStatus (PostgreSQL 15 supports this in transactions)
ALTER TYPE "CandidateStatus" ADD VALUE IF NOT EXISTS 'AWAITING_FIRST_SHIFT';

-- Add new fields to Candidate table
ALTER TABLE "Candidate"
    ADD COLUMN IF NOT EXISTS "testPassed"          BOOLEAN,
    ADD COLUMN IF NOT EXISTS "ndaConfirmedAt"      TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "firstShiftDate"      TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "firstShiftPartnerId" TEXT;

-- Add foreign key constraint from Candidate to StaffProfile
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'Candidate_firstShiftPartnerId_fkey'
          AND table_name = 'Candidate'
    ) THEN
        ALTER TABLE "Candidate"
            ADD CONSTRAINT "Candidate_firstShiftPartnerId_fkey"
            FOREIGN KEY ("firstShiftPartnerId")
            REFERENCES "StaffProfile"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
