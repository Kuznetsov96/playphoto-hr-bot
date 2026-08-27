-- Ссылка локального слота интервью на канонический слот вебаппа (фаза 2b).
--
-- При включённом AWS_RECRUITING_SLOTS_ENABLED бронь идёт в вебапп, а локальная
-- строка InterviewSlot остаётся write-through-зеркалом: на ней держатся
-- напоминания 6h/10m/HR, автозавершение и календарь. NULL — слот локальный,
-- создан по-старому; уникальность не даёт зеркалу задвоить один веб-слот.
ALTER TABLE "InterviewSlot" ADD COLUMN "webSlotPublicId" TEXT;

CREATE UNIQUE INDEX "InterviewSlot_webSlotPublicId_key" ON "InterviewSlot"("webSlotPublicId");
