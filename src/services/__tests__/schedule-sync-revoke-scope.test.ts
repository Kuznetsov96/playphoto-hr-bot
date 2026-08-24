import { describe, expect, it, vi, beforeEach } from "vitest";

const listActive = vi.fn();

vi.mock("../../repositories/known-chat-repository.js", () => ({
    knownChatRepository: {
        listActive: () => listActive(),
    },
}));

import { ScheduleSyncService } from "../schedule-sync.js";

interface FakeApiOptions {
    statuses?: Record<number, string>;
    getChatMemberErrors?: Record<number, any>;
    banErrors?: Record<number, any>;
}

function makeApi(options: FakeApiOptions = {}) {
    const banned: number[] = [];
    const api = {
        banned,
        getChatMember: vi.fn(async (chatId: number) => {
            const err = options.getChatMemberErrors?.[chatId];
            if (err) throw err;
            return { status: options.statuses?.[chatId] ?? "member" };
        }),
        banChatMember: vi.fn(async (chatId: number) => {
            const err = options.banErrors?.[chatId];
            if (err) throw err;
            banned.push(chatId);
        }),
    };
    return api;
}

const TELEGRAM_ID = 1340583088n;

describe("ScheduleSyncService.revokeFromAllTeamChats scope", () => {
    let service: any;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new ScheduleSyncService() as any;
    });

    it("takes its scope from the known chat registry, not from a hardcoded list", async () => {
        listActive.mockResolvedValue([
            { id: -1001111111111n, title: "Команда", type: "supergroup" },
            { id: -1002222222222n, title: "Dragon Park 2", type: "supergroup" },
        ]);
        const api = makeApi();

        const result = await service.revokeFromAllTeamChats(api, TELEGRAM_ID, "STAFF_DEACTIVATED");

        expect(api.banned).toEqual([-1001111111111, -1002222222222]);
        expect(result).toEqual({
            removedFromAtLeastOneChat: true,
            removedFromChatsCount: 2,
            failedChats: [],
        });
    });

    it("covers a location chat that has no telegramChatId in the location directory", async () => {
        // Dragon Park 2 существует в реестре, но не в справочнике локаций —
        // ровно та дыра, ради которой менялась область отзыва.
        listActive.mockResolvedValue([{ id: -1002222222222n, title: "Lviv / Dragon Park 2", type: "supergroup" }]);
        const api = makeApi();

        const result = await service.revokeFromAllTeamChats(api, TELEGRAM_ID, "STAFF_DEACTIVATED");

        expect(api.banned).toEqual([-1002222222222]);
        expect(result.removedFromChatsCount).toBe(1);
    });

    it("bans only where the person is actually present", async () => {
        listActive.mockResolvedValue([
            { id: -1001n, title: "present", type: "supergroup" },
            { id: -1002n, title: "left", type: "supergroup" },
            { id: -1003n, title: "kicked", type: "supergroup" },
            { id: -1004n, title: "restricted", type: "supergroup" },
        ]);
        const api = makeApi({
            statuses: { [-1001]: "member", [-1002]: "left", [-1003]: "kicked", [-1004]: "restricted" },
        });

        const result = await service.revokeFromAllTeamChats(api, TELEGRAM_ID, "STAFF_DEACTIVATED");

        expect(api.banned).toEqual([-1001, -1004]);
        expect(result.removedFromChatsCount).toBe(2);
        expect(result.failedChats).toEqual([]);
    });

    it("records an unqueryable chat as a failure and does not ban in it", async () => {
        listActive.mockResolvedValue([
            { id: -1001n, title: "ok", type: "supergroup" },
            { id: -1002n, title: "unreachable", type: "supergroup" },
        ]);
        const api = makeApi({
            getChatMemberErrors: { [-1002]: { description: "Bad Gateway" } },
        });

        const result = await service.revokeFromAllTeamChats(api, TELEGRAM_ID, "STAFF_DEACTIVATED");

        expect(api.banned).toEqual([-1001]);
        expect(result.removedFromChatsCount).toBe(1);
        expect(result.failedChats).toEqual([{ chatId: -1002, error: "Bad Gateway" }]);
        expect(result.removedFromAtLeastOneChat).toBe(true);
    });

    it.each([
        "member not found",
        "User not found",
        "PARTICIPANT_ID_INVALID",
        "user not participant",
    ])("does not treat %s as a failure", async (description) => {
        listActive.mockResolvedValue([
            { id: -1001n, title: "ok", type: "supergroup" },
            { id: -1002n, title: "absent", type: "supergroup" },
        ]);
        const api = makeApi({ getChatMemberErrors: { [-1002]: { description } } });

        const result = await service.revokeFromAllTeamChats(api, TELEGRAM_ID, "STAFF_DEACTIVATED");

        expect(result.failedChats).toEqual([]);
        expect(result.removedFromChatsCount).toBe(1);
    });

    /**
     * Тот же дефект прода, что и в AccessService, только вторым путём отзыва: в
     * канале с постоянной ссылкой `left` значит «сейчас не внутри», а не «пути
     * назад нет». Набор `participantStatuses` пропускал такого человека, и он
     * возвращался по той же ссылке.
     */
    it("банит в канале, даже когда человек числится left", async () => {
        listActive.mockResolvedValue([{ id: -1001n, title: "Support PlayPhoto", type: "channel" }]);
        const api = makeApi({ statuses: { [-1001]: "left" } });

        const result = await service.revokeFromAllTeamChats(api, TELEGRAM_ID, "STAFF_DEACTIVATED");

        expect(api.banned).toEqual([-1001]);
        expect(result.removedFromChatsCount).toBe(1);
        expect(result.removedFromAtLeastOneChat).toBe(true);
        expect(result.failedChats).toEqual([]);
    });

    /**
     * Признак — колонка `type` реестра, а не конкретный id: второй канал обязан
     * попасть под правило сам, без правки списка руками.
     */
    it("не спрашивает присутствие в канале вовсе", async () => {
        listActive.mockResolvedValue([{ id: -1777n, title: "Другой канал", type: "channel" }]);
        const api = makeApi();

        await service.revokeFromAllTeamChats(api, TELEGRAM_ID, "STAFF_DEACTIVATED");

        expect(api.getChatMember).not.toHaveBeenCalled();
        expect(api.banned).toEqual([-1777]);
    });

    /**
     * Обратная половина правила: в групповом чате локации постоянной ссылки нет,
     * и бан отсутствующего был бы ложной записью о доступе, которого не было.
     */
    it("по-прежнему пропускает супергруппу, где человек left", async () => {
        listActive.mockResolvedValue([{ id: -1002n, title: "Fantasy Town", type: "supergroup" }]);
        const api = makeApi({ statuses: { [-1002]: "left" } });

        const result = await service.revokeFromAllTeamChats(api, TELEGRAM_ID, "STAFF_DEACTIVATED");

        expect(api.banned).toEqual([]);
        expect(result.removedFromChatsCount).toBe(0);
        expect(result.removedFromAtLeastOneChat).toBe(false);
        expect(result.failedChats).toEqual([]);
    });

    it("по-прежнему банит в супергруппе, где человек присутствует", async () => {
        listActive.mockResolvedValue([{ id: -1002n, title: "Fantasy Town", type: "supergroup" }]);
        const api = makeApi({ statuses: { [-1002]: "member" } });

        const result = await service.revokeFromAllTeamChats(api, TELEGRAM_ID, "STAFF_DEACTIVATED");

        expect(api.banned).toEqual([-1002]);
        expect(result.removedFromChatsCount).toBe(1);
    });

    /** Смешанный реестр: канал вслепую, группа — только по факту присутствия. */
    it("разводит канал и супергруппу в одном прогоне", async () => {
        listActive.mockResolvedValue([
            { id: -1001n, title: "Support PlayPhoto", type: "channel" },
            { id: -1002n, title: "Fantasy Town", type: "supergroup" },
        ]);
        const api = makeApi({ statuses: { [-1001]: "left", [-1002]: "left" } });

        const result = await service.revokeFromAllTeamChats(api, TELEGRAM_ID, "STAFF_DEACTIVATED");

        expect(api.getChatMember).toHaveBeenCalledTimes(1);
        expect(api.getChatMember).toHaveBeenCalledWith(-1002, Number(TELEGRAM_ID));
        expect(api.banned).toEqual([-1001]);
        expect(result.removedFromChatsCount).toBe(1);
    });

    /**
     * Бан в канале теперь уходит и за того, кого там никогда не было, поэтому
     * все четыре толерованных описания стали для канала штатным исходом. Провалом
     * они быть не должны, но и в счётчик удалений не идут: удаления не было.
     */
    it.each([
        "member not found",
        "User not found",
        "PARTICIPANT_ID_INVALID",
        "user not participant",
    ])("не считает провалом отказ канала «%s»", async (description) => {
        listActive.mockResolvedValue([{ id: -1001n, title: "Support PlayPhoto", type: "channel" }]);
        const api = makeApi({ banErrors: { [-1001]: { description } } });

        const result = await service.revokeFromAllTeamChats(api, TELEGRAM_ID, "STAFF_DEACTIVATED");

        expect(result.failedChats).toEqual([]);
        expect(result.removedFromChatsCount).toBe(0);
    });

    /** Настоящий отказ канала прикрываться толерантностью не должен. */
    it("отправляет настоящий отказ канала в failedChats", async () => {
        listActive.mockResolvedValue([{ id: -1001n, title: "Support PlayPhoto", type: "channel" }]);
        const api = makeApi({ banErrors: { [-1001]: { description: "Bad Request: CHAT_ADMIN_REQUIRED" } } });

        const result = await service.revokeFromAllTeamChats(api, TELEGRAM_ID, "STAFF_DEACTIVATED");

        expect(result.failedChats).toEqual([
            { chatId: -1001, error: "Bad Request: CHAT_ADMIN_REQUIRED" },
        ]);
        expect(result.removedFromChatsCount).toBe(0);
        expect(result.removedFromAtLeastOneChat).toBe(false);
    });

    it("reports an empty registry as a failure rather than a clean revocation", async () => {
        listActive.mockResolvedValue([]);
        const api = makeApi();

        const result = await service.revokeFromAllTeamChats(api, TELEGRAM_ID, "STAFF_DEACTIVATED");

        expect(api.getChatMember).not.toHaveBeenCalled();
        expect(result.removedFromAtLeastOneChat).toBe(false);
        expect(result.removedFromChatsCount).toBe(0);
        expect(result.failedChats).toHaveLength(1);
        expect(result.failedChats[0].chatId).toBe(0);
        expect(result.failedChats[0].error).toContain("registry is empty");
    });

    it("reports a registry read failure rather than swallowing it", async () => {
        listActive.mockRejectedValue(new Error("connection terminated"));
        const api = makeApi();

        const result = await service.revokeFromAllTeamChats(api, TELEGRAM_ID, "STAFF_DEACTIVATED");

        expect(api.getChatMember).not.toHaveBeenCalled();
        expect(result.removedFromAtLeastOneChat).toBe(false);
        expect(result.removedFromChatsCount).toBe(0);
        expect(result.failedChats).toEqual([{ chatId: 0, error: "connection terminated" }]);
    });

    it("skips zero and NaN ids and de-duplicates the registry", async () => {
        listActive.mockResolvedValue([
            { id: -1001n, title: "ok", type: "supergroup" },
            { id: -1001n, title: "duplicate", type: "supergroup" },
            { id: 0n, title: "zero", type: "supergroup" },
        ]);
        const api = makeApi();

        const result = await service.revokeFromAllTeamChats(api, TELEGRAM_ID, "STAFF_DEACTIVATED");

        expect(api.banned).toEqual([-1001]);
        expect(result.removedFromChatsCount).toBe(1);
    });
});
