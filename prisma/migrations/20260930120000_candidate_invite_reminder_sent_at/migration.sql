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

-- С какого момента кандидатка ждёт время собеседования (нет слотов, не
-- подошло время, отменила или переносит запись). Уведомление о новых слотах
-- уходит, только когда появился слот новее этого момента: до 30.09.2026
-- обещанное «надішлемо сповіщення» не отправлял никто.
ALTER TABLE "Candidate" ADD COLUMN "interviewWaitlistedAt" TIMESTAMP(3);

-- Уже ждущим — момент выката: первый же слот, который бот увидит после
-- него, для них новый, и обещанное уведомление наконец дойдёт.
UPDATE "Candidate"
SET "interviewWaitlistedAt" = now()
WHERE "currentStep" = 'INTERVIEW'
  AND "interviewSlotId" IS NULL
  AND "status" IN ('SCREENING', 'WAITLIST_HR', 'WAITLIST');
