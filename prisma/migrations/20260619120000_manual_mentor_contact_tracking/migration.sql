ALTER TABLE "Candidate" ADD COLUMN "mentorManualContactedAt" TIMESTAMP(3);

UPDATE "Candidate"
SET
  "status" = 'REJECTED',
  "isWaitlisted" = false,
  "lossStage" = 'MENTOR_INTRO',
  "lossReason" = 'LEGACY_MENTOR_WAITLIST_NO_RESPONSE',
  "lostAt" = COALESCE("lostAt", NOW()),
  "statusChangedAt" = NOW(),
  "pipelineTouchedAt" = NOW()
WHERE
  "status" IN ('WAITLIST', 'WAITLIST_MENTOR')
  AND "isWaitlisted" = true
  AND "currentStep" = 'TRAINING';
