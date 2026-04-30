CREATE TYPE "TaskCompletionMode" AS ENUM ('QUICK', 'PROOF_REQUIRED');

CREATE TYPE "TaskProofSubmissionStatus" AS ENUM ('DRAFT', 'SUBMITTED');

CREATE TYPE "TaskProofItemType" AS ENUM ('TEXT', 'PHOTO', 'VIDEO', 'DOCUMENT', 'VOICE', 'AUDIO', 'ANIMATION');

ALTER TABLE "Task"
ADD COLUMN "completionMode" "TaskCompletionMode" NOT NULL DEFAULT 'QUICK',
ADD COLUMN "completedAt" TIMESTAMP(3);

CREATE TABLE "TaskProofSubmission" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "status" "TaskProofSubmissionStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastItemAt" TIMESTAMP(3),

    CONSTRAINT "TaskProofSubmission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaskProofItem" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "type" "TaskProofItemType" NOT NULL,
    "text" TEXT,
    "telegramFileId" TEXT,
    "caption" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskProofItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaskProofSubmission_taskId_key" ON "TaskProofSubmission"("taskId");
CREATE INDEX "TaskProofSubmission_staffId_idx" ON "TaskProofSubmission"("staffId");
CREATE INDEX "TaskProofSubmission_status_idx" ON "TaskProofSubmission"("status");
CREATE INDEX "TaskProofItem_submissionId_createdAt_idx" ON "TaskProofItem"("submissionId", "createdAt");

ALTER TABLE "TaskProofSubmission"
ADD CONSTRAINT "TaskProofSubmission_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskProofSubmission"
ADD CONSTRAINT "TaskProofSubmission_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskProofItem"
ADD CONSTRAINT "TaskProofItem_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "TaskProofSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
