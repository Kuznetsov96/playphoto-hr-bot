-- CreateEnum
CREATE TYPE "FirstShiftOnboardingStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'CLOSING', 'PENDING_FINAL', 'PASSED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FirstShiftOnboardingStepStatus" AS ENUM ('LOCKED', 'ACTIVE', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "FirstShiftOnboardingInputType" AS ENUM ('BUTTON', 'PHOTO', 'MULTIPLE_PHOTOS', 'SCREENSHOT', 'TEXT', 'LINK', 'MENTOR_OBSERVED');

-- CreateTable
CREATE TABLE "FirstShiftOnboardingCase" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "status" "FirstShiftOnboardingStatus" NOT NULL DEFAULT 'OPEN',
    "chatId" BIGINT,
    "topicId" INTEGER,
    "currentStepKey" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "mentorFinalNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FirstShiftOnboardingCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FirstShiftOnboardingStep" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "block" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "inputType" "FirstShiftOnboardingInputType" NOT NULL,
    "status" "FirstShiftOnboardingStepStatus" NOT NULL DEFAULT 'LOCKED',
    "requiresMentorApproval" BOOLEAN NOT NULL DEFAULT true,
    "submittedText" TEXT,
    "photoIds" TEXT,
    "mentorComment" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FirstShiftOnboardingStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FirstShiftOnboardingCase_candidateId_key" ON "FirstShiftOnboardingCase"("candidateId");

-- CreateIndex
CREATE INDEX "FirstShiftOnboardingCase_status_updatedAt_idx" ON "FirstShiftOnboardingCase"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "FirstShiftOnboardingCase_topicId_idx" ON "FirstShiftOnboardingCase"("topicId");

-- CreateIndex
CREATE UNIQUE INDEX "FirstShiftOnboardingStep_caseId_key_key" ON "FirstShiftOnboardingStep"("caseId", "key");

-- CreateIndex
CREATE INDEX "FirstShiftOnboardingStep_caseId_order_idx" ON "FirstShiftOnboardingStep"("caseId", "order");

-- CreateIndex
CREATE INDEX "FirstShiftOnboardingStep_status_idx" ON "FirstShiftOnboardingStep"("status");

-- AddForeignKey
ALTER TABLE "FirstShiftOnboardingCase" ADD CONSTRAINT "FirstShiftOnboardingCase_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FirstShiftOnboardingStep" ADD CONSTRAINT "FirstShiftOnboardingStep_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "FirstShiftOnboardingCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
