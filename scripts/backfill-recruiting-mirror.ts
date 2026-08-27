/**
 * Одноразовый бэкфилл зеркала кандидатов: пушит ВСЕХ кандидатов бота в вебапп
 * через POST /internal/bot/recruiting/candidates.
 *
 * Запуск (из корня репозитория, где лежит .env):
 *   npx tsx scripts/backfill-recruiting-mirror.ts
 *
 * Сознательно НЕ смотрит на AWS_RECRUITING_MIRROR_ENABLED: бэкфилл — явное
 * действие оператора, а флаг управляет только фоновым пушем при записях.
 * Но без AWS_BUSINESS_API_URL/TOKEN пушить некуда — тогда отказ сразу.
 *
 * Пуш идемпотентен (upsert по telegramId), поэтому скрипт можно перезапускать:
 * повторный прогон просто перезапишет зеркало теми же снимками.
 */
import { PrismaClient } from "@prisma/client";
import { AWS_BUSINESS_API_TOKEN, AWS_BUSINESS_API_URL } from "../src/config.js";
import { awsBusinessClient } from "../src/services/aws-business-client.js";
import { buildCandidateMirrorSnapshot } from "../src/services/recruiting-mirror/snapshot.js";

const DELAY_BETWEEN_CALLS_MS = 50;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    if (!AWS_BUSINESS_API_URL || !AWS_BUSINESS_API_TOKEN) {
        console.error("❌ AWS_BUSINESS_API_URL / AWS_BUSINESS_API_TOKEN не заданы — пушить некуда.");
        process.exit(1);
    }

    const prisma = new PrismaClient();
    try {
        const candidates = await prisma.candidate.findMany({
            include: { user: true, location: true, interviewSlot: true },
            orderBy: { pipelineTouchedAt: "asc" },
        });

        console.log(`Кандидатов к пушу: ${candidates.length}`);

        let pushed = 0;
        const failed: Array<{ id: string; error: string }> = [];

        for (const [index, candidate] of candidates.entries()) {
            try {
                const snapshot = buildCandidateMirrorSnapshot(candidate);
                const ack = await awsBusinessClient.pushRecruitingCandidate(snapshot);
                pushed += 1;
                console.log(`[${index + 1}/${candidates.length}] ✅ ${candidate.id} → ${ack.publicId} (${ack.stage})`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                failed.push({ id: candidate.id, error: message });
                console.error(`[${index + 1}/${candidates.length}] ❌ ${candidate.id}: ${message}`);
            }
            // Небольшая пауза — бэкфилл не должен выедать rate-limit у живого API.
            await sleep(DELAY_BETWEEN_CALLS_MS);
        }

        console.log("\n===== Итог =====");
        console.log(`Запушено: ${pushed}`);
        console.log(`С ошибкой: ${failed.length}`);
        if (failed.length > 0) {
            console.log("Кандидаты с ошибкой:");
            for (const { id, error } of failed) {
                console.log(`  - ${id}: ${error}`);
            }
            process.exitCode = 1;
        }
    } finally {
        await prisma.$disconnect();
    }
}

main().catch(error => {
    console.error("❌ Бэкфилл упал:", error);
    process.exit(1);
});
