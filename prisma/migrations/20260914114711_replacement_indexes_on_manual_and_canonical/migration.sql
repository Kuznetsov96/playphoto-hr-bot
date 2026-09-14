-- Індекси створені сирим SQL, Prisma про них не знає — вміст написано вручну.
--
-- ReplacementRequest_active_manual_location_date_key раніше спирався на
-- порожній workShiftId як побічну ознаку ручної заявки. Тепер ознака явна
-- (isManual), тож індекс перевести на неї.
DROP INDEX IF EXISTS "ReplacementRequest_active_manual_location_date_key";
CREATE UNIQUE INDEX "ReplacementRequest_active_manual_location_date_key"
ON "ReplacementRequest"("locationId", "shiftDate")
WHERE "status" = 'ACTIVE' AND "isManual" = true;

-- ReplacementRequest_active_workShiftId_key захищав від двох активних
-- пошуків на одну зміну через локальний workShiftId. Перевести на
-- канонічний scheduledShiftPublicId — нова назва відображає це явно.
DROP INDEX IF EXISTS "ReplacementRequest_active_workShiftId_key";
CREATE UNIQUE INDEX "ReplacementRequest_active_scheduled_shift_key"
ON "ReplacementRequest"("scheduledShiftPublicId")
WHERE "status" = 'ACTIVE' AND "scheduledShiftPublicId" IS NOT NULL;
