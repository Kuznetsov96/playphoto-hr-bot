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
            { id: -1001111111111n, title: "Команда" },
            { id: -1002222222222n, title: "Dragon Park 2" },
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
        listActive.mockResolvedValue([{ id: -1002222222222n, title: "Lviv / Dragon Park 2" }]);
        const api = makeApi();

        const result = await service.revokeFromAllTeamChats(api, TELEGRAM_ID, "STAFF_DEACTIVATED");

        expect(api.banned).toEqual([-1002222222222]);
        expect(result.removedFromChatsCount).toBe(1);
    });

    it("bans only where the person is actually present", async () => {
        listActive.mockResolvedValue([
            { id: -1001n, title: "present" },
            { id: -1002n, title: "left" },
            { id: -1003n, title: "kicked" },
            { id: -1004n, title: "restricted" },
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
            { id: -1001n, title: "ok" },
            { id: -1002n, title: "unreachable" },
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
            { id: -1001n, title: "ok" },
            { id: -1002n, title: "absent" },
        ]);
        const api = makeApi({ getChatMemberErrors: { [-1002]: { description } } });

        const result = await service.revokeFromAllTeamChats(api, TELEGRAM_ID, "STAFF_DEACTIVATED");

        expect(result.failedChats).toEqual([]);
        expect(result.removedFromChatsCount).toBe(1);
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
            { id: -1001n, title: "ok" },
            { id: -1001n, title: "duplicate" },
            { id: 0n, title: "zero" },
        ]);
        const api = makeApi();

        const result = await service.revokeFromAllTeamChats(api, TELEGRAM_ID, "STAFF_DEACTIVATED");

        expect(api.banned).toEqual([-1001]);
        expect(result.removedFromChatsCount).toBe(1);
    });
});
