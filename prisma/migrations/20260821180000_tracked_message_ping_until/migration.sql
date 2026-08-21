-- Докуда пинговать это сообщение. NULL — как раньше, до ответа.
--
-- Напоминания о пожеланиях останавливались только когда человек ответил, и
-- после закрытия окна 26-го бот продолжал звать заполнить форму, которая
-- отвечает «збір закрито» — каждые четыре часа.
ALTER TABLE "TrackedMessage" ADD COLUMN "pingUntil" TIMESTAMP(3);

-- Обычный индекс, а не частичный: схема объявляет @@index([pingUntil]) без
-- условия, и `WHERE pingUntil IS NOT NULL` в SQL давал бы дрейф — Prisma
-- считает такой индекс другим. CI это поймал.
CREATE INDEX "TrackedMessage_pingUntil_idx" ON "TrackedMessage"("pingUntil");
