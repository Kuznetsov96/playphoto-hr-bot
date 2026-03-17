-- AlterEnum
ALTER TYPE "CandidateStatus" ADD VALUE 'DISCOVERY_SCHEDULED';
ALTER TYPE "CandidateStatus" ADD VALUE 'DISCOVERY_COMPLETED';

-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN "discoveryCompletedAt" TIMESTAMP(3),
ADD COLUMN "discoverySlotId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_discoverySlotId_key" ON "Candidate"("discoverySlotId");

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_discoverySlotId_fkey" FOREIGN KEY ("discoverySlotId") REFERENCES "TrainingSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
