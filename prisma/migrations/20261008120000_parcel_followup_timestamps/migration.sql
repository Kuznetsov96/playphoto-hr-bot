-- Відлік і однократні сигнали для посилок, що застрягли без фото.
--
-- Раніше «скільки чекає» рахувалось від updatedAt, який рухає будь-яка правка
-- рядка, а VERIFYING (фото здані, чекають підтвердження підтримки) не мав
-- нагадувань зовсім: на 08.10.2026 шість посилок чекали 11–47 днів.
ALTER TABLE "Parcel" ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "Parcel" ADD COLUMN "verifyingSince" TIMESTAMP(3);
ALTER TABLE "Parcel" ADD COLUMN "claimPromptedAt" TIMESTAMP(3);
ALTER TABLE "Parcel" ADD COLUMN "outsidePickupAlertSentAt" TIMESTAMP(3);
ALTER TABLE "Parcel" ADD COLUMN "photoOverdueAlertSentAt" TIMESTAMP(3);
ALTER TABLE "Parcel" ADD COLUMN "reviewOverdueAlertSentAt" TIMESTAMP(3);

-- Точної миті входу в статус ніде не збережено; updatedAt — найближче, що є.
-- Без бекфілу посилки, які вже тижнями висять, не потрапили б у сигнали ніколи.
UPDATE "Parcel" SET "deliveredAt" = "updatedAt" WHERE "status" = 'DELIVERED';
UPDATE "Parcel" SET "verifyingSince" = "updatedAt" WHERE "status" = 'VERIFYING';
