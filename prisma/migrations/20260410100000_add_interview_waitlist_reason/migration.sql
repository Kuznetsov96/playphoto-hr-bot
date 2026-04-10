-- Add a nullable reason so existing HR waitlist candidates remain visible as legacy/unknown.
ALTER TABLE "Candidate" ADD COLUMN "interviewWaitlistReason" TEXT;
