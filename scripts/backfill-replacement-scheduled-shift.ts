/**
 * Одноразовий бекфіл: заповнює `ReplacementRequest.scheduledShiftPublicId`
 * для заявок, створених до того, як це поле почало записуватись одразу.
 *
 * Чиста логіка — у `src/services/replacement-canonical-backfill.ts`
 * (`backfillReplacementScheduledShiftIds`), покрита юніт-тестами з
 * мок-базою. Цей файл — лише тонка обгортка запуску з реальним prisma.
 *
 * Запуск:
 *   npx tsx scripts/backfill-replacement-scheduled-shift.ts
 */
import prisma from "../src/db/core.js";
import { backfillReplacementScheduledShiftIds } from "../src/services/replacement-canonical-backfill.js";

backfillReplacementScheduledShiftIds(prisma)
    .then(result => {
        console.log(`scanned=${result.scanned} filled=${result.filled} unmatched=${result.unmatched}`);
        if (result.unmatched > 0) {
            console.warn(`УВАГА: ${result.unmatched} заявок лишились без канонічного id — перевір їх вручну.`);
        }
        return prisma.$disconnect();
    })
    .catch(async error => {
        console.error(error);
        await prisma.$disconnect();
        process.exit(1);
    });
