// Разовый перенос существующих рассылок в вебапп (раздел Announcements).
// Ставит в очередь синк снимка каждой рассылки; задачи идут с нарастающей
// задержкой (500 мс на рассылку), так что сотни рассылок уходят за минуты.
//
// Запуск в контейнере бота после выката с ANNOUNCEMENTS_SYNC_ENABLED=true
// (раннер вебаппа apps/api/scripts/run-delivery-expense-audit.sh с
// CONTAINER=playphoto-bot-bot-1 или вручную):
//
//   docker exec playphoto-bot-bot-1 node /app/scripts/backfill-announcements.mjs
//
// Безопасно перезапускать: ждущая задача не дублируется. Если флаг выключен —
// выходит с кодом 1.

const code = await main();
// exitCode гарантирует правильный код, даже если цикл событий опустеет раньше таймера.
process.exitCode = code;
// Prisma, Redis очереди и логгер держат соединения — без явного выхода процесс висит.
setTimeout(() => process.exit(code), 200).unref();

async function main() {
    // До любых импортов из dist: ни Prisma, ни Redis не открываются.
    if (process.env.ANNOUNCEMENTS_SYNC_ENABLED !== "true") {
        console.error("ANNOUNCEMENTS_SYNC_ENABLED is not true in this container: nothing was enqueued. Deploy with the flag on first.");
        return 1;
    }
    try {
        const { enqueueAllAnnouncementSyncs } = await import("/app/dist/services/announcement-sync.js");
        const count = await enqueueAllAnnouncementSyncs();
        console.log(`Enqueued ${count} announcement snapshots`);
        return 0;
    } catch (error) {
        console.error(error);
        return 1;
    } finally {
        try {
            const { default: prisma } = await import("/app/dist/db/core.js");
            await prisma.$disconnect();
            const { defaultQueue } = await import("/app/dist/core/queue.js");
            await defaultQueue.close();
        } catch {
            // соединения закроет process.exit
        }
    }
}
