-- Когда ушло напоминание «запрошення ще діє». Держит его однократным.
--
-- Раньше однократность держало окно «от 24 до 25 часов после приглашения»,
-- рассчитанное на вокер раз в час. Вокер крутится каждые 5 минут, и в окно
-- кандидатка попадала около 12 раз подряд.
ALTER TABLE "Candidate" ADD COLUMN "interviewInviteReminderSentAt" TIMESTAMP(3);

-- Приглашённым больше суток назад напоминание уже пришло (и не одно):
-- без отметки после выката им ушло бы ещё одно.
UPDATE "Candidate"
SET "interviewInviteReminderSentAt" = now()
WHERE "interviewInvitedAt" IS NOT NULL
  AND "interviewInvitedAt" <= now() - interval '24 hours';
