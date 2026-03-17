-- AlterTable
ALTER TABLE "OutgoingTopic" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
DROP INDEX "OutgoingTopic_isClosed_createdAt_idx";
CREATE INDEX "OutgoingTopic_isClosed_updatedAt_idx" ON "OutgoingTopic"("isClosed", "updatedAt");
