-- Докуда пинговать это сообщение. NULL — как раньше, до ответа.
--
-- Напоминания о пожеланиях останавливались только когда человек ответил, и
-- после закрытия окна 26-го бот продолжал звать заполнить форму, которая
-- отвечает «збір закрито» — каждые четыре часа.
ALTER TABLE "TrackedMessage" ADD COLUMN "pingUntil" TIMESTAMP(3);

-- Частичный индекс: строк с дедлайном мало, а условие проверяется на каждом
-- тике пингера вместе с nextPingAt.
CREATE INDEX "TrackedMessage_pingUntil_idx" ON "TrackedMessage"("pingUntil") WHERE "pingUntil" IS NOT NULL;
