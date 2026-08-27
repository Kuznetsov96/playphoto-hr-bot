/**
 * Одноразовый бэкфилл зеркала кандидатов: пушит ВСЕХ кандидатов бота в вебапп
 * через POST /internal/bot/recruiting/candidates.
 *
 * Запуск из корня репозитория (где лежит .env):
 *   npx tsx scripts/backfill-recruiting-mirror.ts
 * Запуск внутри прод-контейнера (исходников src там нет, только dist):
 *   docker exec playphoto-bot-bot-1 npx tsx /app/scripts/backfill-recruiting-mirror.ts
 *
 * Сознательно НЕ смотрит на AWS_RECRUITING_MIRROR_ENABLED: бэкфилл — явное
 * действие оператора, а флаг управляет только фоновым пушем при записях.
 * Но без AWS_BUSINESS_API_URL/TOKEN пушить некуда — тогда отказ сразу.
 *
 * Пуш идемпотентен (upsert по telegramId), поэтому скрипт можно перезапускать:
 * повторный прогон просто перезапишет зеркало теми же снимками.
 */
import { PrismaClient } from "@prisma/client";

/*
 * Импорты — динамические с фолбэком на dist. Статический `../src/config.js`
 * уронил первый прод-прогон 27.08.2026 мгновенной ошибкой ERR_MODULE_NOT_FOUND:
 * в образ попадают только scripts/ и dist/, каталога src там нет. Из репозитория
 * tsx резолвит src (свежий код без сборки), из контейнера — собранный dist.
 */
type BackfillDeps = {
    AWS_BUSINESS_API_URL: string | undefined;
    AWS_BUSINESS_API_TOKEN: string | undefined;
    awsBusinessClient: {
        pushRecruitingCandidate: (snapshot: unknown) => Promise<{ publicId: string; stage: string }>;
    };
    buildCandidateMirrorSnapshot: (candidate: unknown) => unknown;
};

async function loadDeps(): Promise<BackfillDeps> {
    try {
        const config = await import("../src/config.js");
        const client = await import("../src/services/aws-business-client.js");
        const snapshot = await import("../src/services/recruiting-mirror/snapshot.js");
        return {
            AWS_BUSINESS_API_URL: config.AWS_BUSINESS_API_URL,
            AWS_BUSINESS_API_TOKEN: config.AWS_BUSINESS_API_TOKEN,
            awsBusinessClient: client.awsBusinessClient,
            buildCandidateMirrorSnapshot: snapshot.buildCandidateMirrorSnapshot,
        };
    } catch {
        const config = await import("../dist/config.js");
        const client = await import("../dist/services/aws-business-client.js");
        const snapshot = await import("../dist/services/recruiting-mirror/snapshot.js");
        return {
            AWS_BUSINESS_API_URL: config.AWS_BUSINESS_API_URL,
            AWS_BUSINESS_API_TOKEN: config.AWS_BUSINESS_API_TOKEN,
            awsBusinessClient: client.awsBusinessClient,
            buildCandidateMirrorSnapshot: snapshot.buildCandidateMirrorSnapshot,
        };
    }
}

const DELAY_BETWEEN_CALLS_MS = 50;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    const { AWS_BUSINESS_API_URL, AWS_BUSINESS_API_TOKEN, awsBusinessClient, buildCandidateMirrorSnapshot } =
        await loadDeps();

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
