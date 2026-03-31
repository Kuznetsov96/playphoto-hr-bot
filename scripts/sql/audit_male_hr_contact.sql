-- Audit male candidates who still have HR-message history or unread flags.
-- Safe: read-only SELECTs first. Run the UPDATE only after review.

-- 1. Summary list
SELECT
  c.id,
  c."fullName",
  u.username,
  c.city,
  c.status,
  c.gender,
  c."hasUnreadMessage",
  COUNT(m.id) FILTER (WHERE m.scope = 'HR') AS hr_message_count,
  MAX(m."createdAt") FILTER (WHERE m.scope = 'HR' AND m.sender = 'USER') AS last_user_to_hr_at,
  MAX(m."createdAt") FILTER (WHERE m.scope = 'HR' AND m.sender <> 'USER') AS last_team_to_candidate_at
FROM "Candidate" c
JOIN "User" u ON u.id = c."userId"
LEFT JOIN "Message" m ON m."candidateId" = c.id
WHERE c.gender = 'male'
GROUP BY c.id, c."fullName", u.username, c.city, c.status, c.gender, c."hasUnreadMessage"
HAVING c."hasUnreadMessage" = true
   OR COUNT(m.id) FILTER (WHERE m.scope = 'HR') > 0
ORDER BY c."hasUnreadMessage" DESC, last_user_to_hr_at DESC NULLS LAST, last_team_to_candidate_at DESC NULLS LAST;

-- 2. Detailed last HR messages for a specific candidate
-- Replace :candidate_id manually before running.
-- SELECT id, sender, scope, "createdAt", content
-- FROM "Message"
-- WHERE "candidateId" = ':candidate_id' AND scope = 'HR'
-- ORDER BY "createdAt" DESC
-- LIMIT 20;

-- 3. Optional safe cleanup: reset unread flags for all male candidates.
-- Review the SELECT above first, then run inside a transaction if needed.
-- BEGIN;
-- UPDATE "Candidate"
-- SET "hasUnreadMessage" = false
-- WHERE gender = 'male'
--   AND "hasUnreadMessage" = true;
-- COMMIT;
