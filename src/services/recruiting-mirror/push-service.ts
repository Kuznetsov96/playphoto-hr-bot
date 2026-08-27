import { RECRUITING_MIRROR_ENABLED } from "../../config.js";
import { logBusinessEvent } from "../../core/log-events.js";
import { buildCandidateMirrorSnapshot } from "./snapshot.js";

export const RECRUITING_MIRROR_JOB_NAME = "recruiting-mirror-push";

/**
 * Ставит пуш снимка кандидата в очередь. Вызывается из candidate-repository
 * после каждой успешной записи — fire-and-forget: отказ очереди не должен
 * ломать основную запись, поэтому вызывающая сторона оборачивает вызов в
 * `.catch(() => {})`, а здесь при выключенном флаге полный no-op (даже без
 * импорта очереди — Redis не трогается вовсе).
 *
 * Джоб несёт только `candidateId`, не снимок: воркер перечитывает кандидата
 * свежим, так что ретрай после гонки записей пушит актуальное состояние.
 */
export async function enqueueCandidateMirrorPush(candidateId: string): Promise<void> {
    if (!RECRUITING_MIRROR_ENABLED) return;
    const { defaultQueue } = await import("../../core/queue.js");
    await defaultQueue.add(
        RECRUITING_MIRROR_JOB_NAME,
        { candidateId },
        { attempts: 5, backoff: { type: "exponential", delay: 10000 } }
    );
}

/**
 * Обработчик джоба (регистрируется в src/workers/index.ts): грузит кандидата
 * свежим с релейшенами, строит снимок и пушит в вебапп. Кандидата уже нет —
 * лог и успех: удалённых не зеркалим, а вечный ретрай по ним только засорял
 * бы очередь. Ошибка пуша пробрасывается — ретраями управляет BullMQ.
 */
export async function processCandidateMirrorPush(candidateId: string): Promise<void> {
    // Prisma напрямую, а не candidateRepository: репозиторий ставит наши же
    // джобы, и обратный импорт замкнул бы цикл (check-cycles держит базлайн 0).
    const { default: prisma } = await import("../../db/core.js");
    const candidate = await prisma.candidate.findUnique({
        where: { id: candidateId },
        include: { user: true, location: true, interviewSlot: true },
    });

    if (!candidate) {
        logBusinessEvent({
            event: "recruiting_mirror.push.skipped",
            candidateId,
            actorType: "system",
            actorRole: "system",
            result: "skipped",
            reasonCode: "CANDIDATE_NOT_FOUND",
            module: "recruiting-mirror",
            operation: "processCandidateMirrorPush",
        });
        return;
    }

    const snapshot = buildCandidateMirrorSnapshot(candidate);
    const { awsBusinessClient } = await import("../aws-business-client.js");

    try {
        const ack = await awsBusinessClient.pushRecruitingCandidate(snapshot);
        logBusinessEvent({
            event: "recruiting_mirror.push.completed",
            candidateId,
            telegramId: snapshot.telegramId,
            actorType: "system",
            actorRole: "system",
            stage: snapshot.botStatus,
            result: "success",
            module: "recruiting-mirror",
            operation: "processCandidateMirrorPush",
            safeContext: { publicId: ack.publicId, stage: ack.stage },
        });
    } catch (error) {
        logBusinessEvent({
            event: "recruiting_mirror.push.failed",
            level: "warn",
            candidateId,
            telegramId: snapshot.telegramId,
            actorType: "system",
            actorRole: "system",
            stage: snapshot.botStatus,
            result: "failed",
            module: "recruiting-mirror",
            operation: "processCandidateMirrorPush",
            error,
        });
        throw error;
    }
}
