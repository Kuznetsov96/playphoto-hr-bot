import { describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn().mockResolvedValue([]) }));

vi.mock("../../db/core.js", () => ({
    default: { trackedMessage: { findMany } },
}));

const { trackedMessageRepository } = await import("../tracked-message-repository.js");

/**
 * Напоминания о пожеланиях останавливались только когда человек ответил —
 * даты в условии не было вообще. После закрытия окна 26-го бот продолжал
 * звать заполнить форму, которая отвечает «збір закрито». Каждые четыре часа.
 */
describe("окно напоминаний", () => {
    it("не берёт сообщения, у которых окно уже истекло", async () => {
        const now = new Date("2026-08-27T09:00:00.000Z");

        await trackedMessageRepository.findToPing(now);

        expect(findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    nextPingAt: { lte: now },
                    OR: [{ pingUntil: null }, { pingUntil: { gt: now } }],
                }),
            }),
        );
    });

    it("оставляет бессрочные рассылки как были", async () => {
        // У обычных рассылок дедлайна нет, и они не должны молча замолкнуть:
        // `pingUntil: null` — это «пинговать, пока не ответят», как раньше.
        const now = new Date("2026-08-27T09:00:00.000Z");

        await trackedMessageRepository.findToPing(now);

        const where = findMany.mock.calls.at(-1)?.[0]?.where;
        expect(where.OR).toContainEqual({ pingUntil: null });
    });
});
