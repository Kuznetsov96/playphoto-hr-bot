import { describe, expect, it, vi, beforeEach } from "vitest";

const listActive = vi.fn();
vi.mock("../../repositories/known-chat-repository.js", () => ({
    knownChatRepository: { listActive: () => listActive() },
}));

const { getRevocationChats, isAbsentMemberError } = await import("../revocation-scope.js");

describe("getRevocationChats", () => {
    beforeEach(() => {
        listActive.mockReset();
    });

    it("сужает bigint до number, сохраняя отрицательные id супергрупп и каналов", async () => {
        listActive.mockResolvedValue([
            { id: -1001234567890n, title: "Канал команды", type: "channel" },
            { id: -1009876543210n, title: "Локация", type: "supergroup" },
        ]);

        const chats = await getRevocationChats();

        expect(chats).toEqual([
            { id: -1001234567890, title: "Канал команды", type: "channel" },
            { id: -1009876543210, title: "Локация", type: "supergroup" },
        ]);
        // Именно number, а не bigint: на границе Telegram API другой тип не примут.
        expect(chats.every(chat => typeof chat.id === "number")).toBe(true);
    });

    it("отбрасывает нулевые id", async () => {
        listActive.mockResolvedValue([
            { id: 0n, title: "Мусорная строка", type: "group" },
            { id: -100500n, title: "Живой чат", type: "group" },
        ]);

        expect(await getRevocationChats()).toEqual([
            { id: -100500, title: "Живой чат", type: "group" },
        ]);
    });

    it("отбрасывает id, которые не сужаются в число", async () => {
        listActive.mockResolvedValue([
            { id: "не число" as unknown as bigint, title: "Битая строка", type: "group" },
            { id: -777n, title: "Живой чат", type: "group" },
        ]);

        expect(await getRevocationChats()).toEqual([
            { id: -777, title: "Живой чат", type: "group" },
        ]);
    });

    it("схлопывает дубли по id, оставляя первое вхождение", async () => {
        listActive.mockResolvedValue([
            { id: -100n, title: "Первое название", type: "channel" },
            { id: -100n, title: "Второе название", type: "supergroup" },
            { id: -200n, title: "Другой чат", type: "group" },
        ]);

        expect(await getRevocationChats()).toEqual([
            { id: -100, title: "Первое название", type: "channel" },
            { id: -200, title: "Другой чат", type: "group" },
        ]);
    });

    it("пропускает тип чата наружу без изменений — по нему решают, нужна ли проверка присутствия", async () => {
        listActive.mockResolvedValue([
            { id: -1n, title: null, type: "channel" },
            { id: -2n, title: null, type: "supergroup" },
            { id: -3n, title: null, type: "group" },
        ]);

        expect((await getRevocationChats()).map(chat => chat.type)).toEqual([
            "channel",
            "supergroup",
            "group",
        ]);
    });

    it("отдаёт пустой список на пустом реестре, а не выдумывает чаты", async () => {
        listActive.mockResolvedValue([]);
        expect(await getRevocationChats()).toEqual([]);
    });

    it("пробрасывает сбой чтения реестра наверх — область отзыва неизвестна", async () => {
        listActive.mockRejectedValue(new Error("db down"));
        await expect(getRevocationChats()).rejects.toThrow("db down");
    });
});

describe("isAbsentMemberError", () => {
    it.each([
        "Bad Request: user not found",
        "Bad Request: member not found",
        "Bad Request: PARTICIPANT_ID_INVALID",
        "Bad Request: user not participant",
    ])("терпит «человека здесь нет»: %s", description => {
        expect(isAbsentMemberError(description)).toBe(true);
    });

    /**
     * Одно состояние приходит в двух написаниях: с пробелами из Bot API и
     * подчёркнутым кодом из слоя MTProto. Пробельный маркер не ловил
     * подчёркнутую форму вовсе, и отсутствующий участник уезжал в провал строки.
     */
    it.each([
        ["user not participant", "Bad Request: user not participant", "Bad Request: USER_NOT_PARTICIPANT"],
        ["participant id invalid", "Bad Request: participant_id_invalid", "Bad Request: PARTICIPANT_ID_INVALID"],
        ["user not found", "Bad Request: user not found", "Bad Request: USER_NOT_FOUND"],
        ["member not found", "Bad Request: member not found", "Bad Request: MEMBER_NOT_FOUND"],
    ])("ловит оба написания маркера %s", (_marker, spaced, underscored) => {
        expect(isAbsentMemberError(spaced)).toBe(true);
        expect(isAbsentMemberError(underscored)).toBe(true);
    });

    /**
     * Приведение подчёркиваний к пробелам расширяет совпадение, поэтому
     * подчёркнутые коды отказов проверяются отдельно: они не должны начать
     * проходить как «участника здесь нет».
     */
    it.each([
        "Bad Request: USER_ADMIN_INVALID",
        "Bad Request: PEER_ID_INVALID",
        "Bad Request: USER_ID_INVALID",
        "Bad Request: PARTICIPANT_ID_EMPTY",
        "Bad Request: USER_NOT_MUTUAL_CONTACT",
        "Bad Request: USER_BANNED_IN_CHANNEL",
    ])("не терпит подчёркнутый код отказа: %s", description => {
        expect(isAbsentMemberError(description)).toBe(false);
    });

    it.each([
        "Bad Request: CHAT_ADMIN_REQUIRED",
        "Bad Request: not enough rights to restrict/unrestrict chat member",
        "Bad Request: chat not found",
        "Forbidden: bot was kicked from the supergroup chat",
        "Bad Request: user is an administrator of the chat",
        "ETIMEDOUT",
    ])("не терпит настоящий отказ: %s", description => {
        expect(isAbsentMemberError(description)).toBe(false);
    });

    it("не терпит пустое и отсутствующее описание", () => {
        expect(isAbsentMemberError("")).toBe(false);
        expect(isAbsentMemberError(null)).toBe(false);
        expect(isAbsentMemberError(undefined)).toBe(false);
    });
});
