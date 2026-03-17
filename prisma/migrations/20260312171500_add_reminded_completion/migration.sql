-- AlterTable
ALTER TABLE "InterviewSlot" ADD COLUMN "remindedCompletion" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TrainingSlot" ADD COLUMN "remindedCompletion" BOOLEAN NOT NULL DEFAULT false;
