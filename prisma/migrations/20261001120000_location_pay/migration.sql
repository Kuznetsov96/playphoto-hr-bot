-- Умови оплати точки для блоку «Твоя робота» (рішення власника 01.10.2026).
-- Приходять знімком із картки локації вебаппа:
-- { weekdayPercent, weekendPercent, weekdayPairPercent, weekendPairPercent,
--   weekdayGuarantee, weekendGuarantee }. Раніше блок брав оплату з
-- захардкодженого location-data-helper.ts (російською, розходилась із вебаппом).
ALTER TABLE "Location" ADD COLUMN "pay" JSONB;

-- Бекфілу немає: NULL — «умов не задано», блок просто не покаже рядків
-- оплати й гарантії, а перший синк знімка заповнить колонку.
