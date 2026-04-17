-- One-off production backfill for legacy candidates that remained in the
-- pre-interview funnel after age-gating rules were tightened.
--
-- Safe usage:
-- 1. Run the preview query first and inspect affected rows/count.
-- 2. Run the UPDATE inside a transaction.
-- 3. Verify the final rows before COMMIT.
--
-- Preview affected candidates
WITH affected AS (
    SELECT
        c.id,
        c."fullName",
        u."telegramId",
        c.status,
        c."currentStep",
        c."hrDecision",
        c."birthDate",
        DATE_PART('year', AGE(CURRENT_DATE, c."birthDate"::date))::int AS age_years,
        CASE
            WHEN DATE_PART('year', AGE(CURRENT_DATE, c."birthDate"::date)) < 17 THEN 'REJECTED_SYSTEM_UNDERAGE'
            WHEN DATE_PART('year', AGE(CURRENT_DATE, c."birthDate"::date)) > 26 THEN 'AGE_LIMIT'
            ELSE NULL
        END AS target_hr_decision
    FROM "Candidate" c
    JOIN "User" u ON u.id = c."userId"
    WHERE c.status IN ('SCREENING', 'WAITLIST_HR', 'WAITLIST', 'MANUAL_REVIEW')
      AND c."birthDate" IS NOT NULL
      AND (
          DATE_PART('year', AGE(CURRENT_DATE, c."birthDate"::date)) < 17
          OR DATE_PART('year', AGE(CURRENT_DATE, c."birthDate"::date)) > 26
      )
)
SELECT *
FROM affected
ORDER BY age_years DESC, "birthDate" ASC;

-- Apply backfill
BEGIN;

WITH affected AS (
    SELECT
        c.id,
        CASE
            WHEN DATE_PART('year', AGE(CURRENT_DATE, c."birthDate"::date)) < 17 THEN 'REJECTED_SYSTEM_UNDERAGE'
            WHEN DATE_PART('year', AGE(CURRENT_DATE, c."birthDate"::date)) > 26 THEN 'AGE_LIMIT'
            ELSE NULL
        END AS target_hr_decision
    FROM "Candidate" c
    WHERE c.status IN ('SCREENING', 'WAITLIST_HR', 'WAITLIST', 'MANUAL_REVIEW')
      AND c."birthDate" IS NOT NULL
      AND (
          DATE_PART('year', AGE(CURRENT_DATE, c."birthDate"::date)) < 17
          OR DATE_PART('year', AGE(CURRENT_DATE, c."birthDate"::date)) > 26
      )
)
UPDATE "Candidate" c
SET
    status = 'REJECTED'::"CandidateStatus",
    "hrDecision" = affected.target_hr_decision,
    "isWaitlisted" = false,
    "notificationSent" = false,
    "interviewWaitlistReason" = NULL,
    "interviewInvitedAt" = NULL,
    "hasUnreadMessage" = false,
    "statusChangedAt" = NOW(),
    "pipelineTouchedAt" = NOW()
FROM affected
WHERE c.id = affected.id;

-- Verify before commit
SELECT
    c.id,
    c."fullName",
    c.status,
    c."hrDecision",
    c."birthDate"
FROM "Candidate" c
WHERE c.status = 'REJECTED'
  AND c."hrDecision" IN ('REJECTED_SYSTEM_UNDERAGE', 'AGE_LIMIT')
ORDER BY c."statusChangedAt" DESC
LIMIT 100;

COMMIT;
