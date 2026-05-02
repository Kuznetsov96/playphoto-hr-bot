CREATE TYPE "TaskProofSupportTopicStatus" AS ENUM ('OPEN', 'WAITING_FOR_STAFF', 'WAITING_FOR_SUPPORT', 'CLOSED');

ALTER TABLE "TaskProofSubmission"
ADD COLUMN "supportChatId" BIGINT,
ADD COLUMN "supportTopicId" INTEGER,
ADD COLUMN "supportTopicStatus" "TaskProofSupportTopicStatus",
ADD COLUMN "supportTopicOpenedAt" TIMESTAMP(3),
ADD COLUMN "supportTopicClosedAt" TIMESTAMP(3),
ADD COLUMN "supportLastMessageAt" TIMESTAMP(3);

CREATE INDEX "TaskProofSubmission_supportChatId_supportTopicId_idx" ON "TaskProofSubmission"("supportChatId", "supportTopicId");
CREATE INDEX "TaskProofSubmission_supportTopicStatus_supportLastMessageAt_idx" ON "TaskProofSubmission"("supportTopicStatus", "supportLastMessageAt");
