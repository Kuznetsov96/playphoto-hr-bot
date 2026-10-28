import { Prisma } from "@prisma/client";
import prisma from "../db/core.js";

/** Сколько последних выполненных действий уходит в снимок (лимит вебаппа). */
export const ACTIONS_DONE_LIMIT = 50;

/** chatId строки-счётчика попыток в BroadcastReminderMark: настоящих чатов с id 0 не бывает. */
const ATTEMPTS_CHAT_ID = 0n;

/**
 * Журнал действий вебаппа над рассылкой и отметки «кому ручное напоминание уже
 * ушло». Вебапп выдаёт действие at-least-once, publicId — ключ идемпотентности.
 */
export class BroadcastActionRepository {
    async findLog(publicId: string) {
        return prisma.broadcastActionLog.findUnique({ where: { publicId } });
    }

    /** Помечает действие выполненным. Повтор с тем же publicId ничего не меняет. */
    async markDone(publicId: string, broadcastId: number, kind: string, result?: Prisma.InputJsonValue) {
        await prisma.broadcastActionLog.createMany({
            data: [{ publicId, broadcastId, kind, ...(result !== undefined ? { result } : {}) }],
            skipDuplicates: true,
        });
    }

    async recentDonePublicIds(broadcastId: number, limit: number = ACTIONS_DONE_LIMIT): Promise<string[]> {
        const rows = await prisma.broadcastActionLog.findMany({
            where: { broadcastId },
            orderBy: [{ doneAt: "desc" }, { publicId: "desc" }],
            take: limit,
            select: { publicId: true },
        });
        return rows.map(r => r.publicId);
    }

    /** Занимает чат под действие: true — отметка поставлена нами, false — уже была (второе не шлём). */
    async claimReminderMark(broadcastId: number, chatId: bigint, actionPublicId: string): Promise<boolean> {
        const result = await prisma.broadcastReminderMark.createMany({
            data: [{ broadcastId, chatId, actionPublicId }],
            skipDuplicates: true,
        });
        return result.count === 1;
    }

    /** Чаты, которым это действие уже слало (отметка стоит): повтор правки не возвращает им кнопки. */
    async findMarkedChats(broadcastId: number, actionPublicId: string): Promise<Set<string>> {
        const rows = await prisma.broadcastReminderMark.findMany({
            where: { broadcastId, actionPublicId, chatId: { not: ATTEMPTS_CHAT_ID } },
            select: { chatId: true },
        });
        return new Set(rows.map(r => String(r.chatId)));
    }

    /**
     * Счётчик тиков отложенного напоминания (строка-отметка с chatId = 0, реального чата с
     * таким id нет). Возвращает, сколько раз уже повторяли после этого вызова.
     */
    async bumpAttempts(broadcastId: number, actionPublicId: string): Promise<number> {
        const row = await prisma.broadcastReminderMark.upsert({
            where: { actionPublicId_chatId: { actionPublicId, chatId: ATTEMPTS_CHAT_ID } },
            create: { broadcastId, chatId: ATTEMPTS_CHAT_ID, actionPublicId, attempts: 1 },
            update: { attempts: { increment: 1 } },
            select: { attempts: true },
        });
        return row.attempts;
    }

    /** Отправка не состоялась: отметку снимаем, чтобы повтор команды мог дослать. */
    async releaseReminderMark(chatId: bigint, actionPublicId: string) {
        await prisma.broadcastReminderMark.deleteMany({ where: { actionPublicId, chatId } });
    }
}

export const broadcastActionRepository = new BroadcastActionRepository();
