import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { migrateLegacyConversations, runDailySupportThreadJobs, runSupportThreadTick } = await import("../support-thread-migration.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const CHAT = -1001234;

function setup(rows: Any[], options: { done?: boolean; lease?: boolean } = {}) {
    const store = new Map<string, string>();
    if (options.done) store.set("support:threads:migrated:v1", "1");
    if (options.lease) store.set("support:threads:migration:lease", "x");
    const redis = {
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        set: vi.fn(async (key: string, value: string, ...args: Any[]) => {
            if (args.includes("NX") && store.has(key)) return null;
            store.set(key, value);
            return "OK";
        }),
        del: vi.fn(async (key: string) => { store.delete(key); return 1; }),
    };
    const api: Any = {
        sendMessage: vi.fn(async () => ({ message_id: 1 })),
        closeForumTopic: vi.fn(async () => true),
    };
    const repo: Any = {
        listLegacyActive: vi.fn(async () => rows),
        closeLegacy: vi.fn(async () => undefined),
    };
    const threads: Any = {
        ensureThread: vi.fn(async (_api: Any, userId: string) => {
            if (userId === "candidate") throw new Error("no staff profile");
            if (userId === "broken") throw new Error("Telegram 500");
            return { id: `thread-${userId}`, chatId: BigInt(CHAT), topicId: userId === "u1" ? 900 : 901 };
        }),
    };
    const deps = { redis, repo, threads, supportChatId: () => CHAT, topicLink: (_c: Any, t: number) => `link/${t}`, sleep: vi.fn(async () => undefined) };
    return { deps, api, repo, threads, redis, store };
}

beforeEach(() => vi.clearAllMocks());

describe("перехід на постійні теми", () => {
    it("уже виконаний — нічого не робить", async () => {
        const { deps, api, repo } = setup([], { done: true });
        await expect(migrateLegacyConversations(api, deps)).resolves.toEqual({ migrated: 0, skipped: 0, failed: 0 });
        expect(repo.listLegacyActive).not.toHaveBeenCalled();
    });

    it("інший процес уже мігрує — нічого не робить", async () => {
        const { deps, api, repo } = setup([], { lease: true });
        await migrateLegacyConversations(api, deps);
        expect(repo.listLegacyActive).not.toHaveBeenCalled();
    });

    it("усі старі розмови людини — в одну тему, з посиланнями туди й назад", async () => {
        const { deps, api, repo, store } = setup([
            { userId: "u1", topics: [{ chatId: BigInt(CHAT), topicId: 10 }, { chatId: BigInt(CHAT), topicId: 11 }, { chatId: BigInt(CHAT), topicId: 12 }], ticketIds: [1, 2], outgoingIds: [], proofIds: ["p1"] },
        ]);
        await expect(migrateLegacyConversations(api, deps)).resolves.toEqual({ migrated: 1, skipped: 0, failed: 0 });
        expect(api.sendMessage).toHaveBeenCalledWith(CHAT, "⬅️ Previous conversation: link/10 · link/11 · link/12", { message_thread_id: 900 });
        for (const topicId of [10, 11, 12]) {
            expect(api.sendMessage).toHaveBeenCalledWith(CHAT, "➡️ Moved to the permanent topic: link/900", { message_thread_id: topicId });
            expect(api.closeForumTopic).toHaveBeenCalledWith(CHAT, topicId);
        }
        expect(repo.closeLegacy).toHaveBeenCalledWith({ ticketIds: [1, 2], outgoingIds: [], proofIds: ["p1"] });
        expect(store.get("support:threads:migrated:v1")).toBe("1");
    });

    it("тема кандидатки лишається старою", async () => {
        const { deps, api, repo } = setup([{ userId: "candidate", topics: [{ chatId: BigInt(CHAT), topicId: 20 }], ticketIds: [5], outgoingIds: [], proofIds: [] }]);
        await expect(migrateLegacyConversations(api, deps)).resolves.toEqual({ migrated: 0, skipped: 1, failed: 0 });
        expect(repo.closeLegacy).not.toHaveBeenCalled();
        expect(api.closeForumTopic).not.toHaveBeenCalled();
    });

    it("збій на одній людині не зупиняє інших і не ставить позначку «готово»", async () => {
        const { deps, api, store } = setup([
            { userId: "broken", topics: [{ chatId: BigInt(CHAT), topicId: 30 }], ticketIds: [7], outgoingIds: [], proofIds: [] },
            { userId: "u2", topics: [{ chatId: BigInt(CHAT), topicId: 31 }], ticketIds: [8], outgoingIds: [], proofIds: [] },
        ]);
        await expect(migrateLegacyConversations(api, deps)).resolves.toEqual({ migrated: 1, skipped: 0, failed: 1 });
        expect(store.has("support:threads:migrated:v1")).toBe(false);
        expect(store.has("support:threads:migration:lease")).toBe(false);
    });

    it("лок переходу короткий і продовжується на кожній людині — після падіння процесу повтор за хвилини", async () => {
        const { deps, api, redis } = setup([
            { userId: "u1", topics: [], ticketIds: [1], outgoingIds: [], proofIds: [] },
            { userId: "u2", topics: [], ticketIds: [2], outgoingIds: [], proofIds: [] },
        ]);
        await migrateLegacyConversations(api, deps);
        const leaseCalls = redis.set.mock.calls.filter((c: Any[]) => c[0] === "support:threads:migration:lease");
        expect(leaseCalls[0]).toEqual(["support:threads:migration:lease", expect.any(String), "PX", 300_000, "NX"]);
        expect(leaseCalls.length).toBeGreaterThanOrEqual(3);
        expect(leaseCalls.slice(1).every((c: Any[]) => c[2] === "PX" && c[3] === 300_000 && !c.includes("NX"))).toBe(true);
    });

    it("пауза між людьми — щоб не впертися в ліміт групи", async () => {
        const { deps, api } = setup([
            { userId: "u1", topics: [], ticketIds: [1], outgoingIds: [], proofIds: [] },
            { userId: "u2", topics: [], ticketIds: [2], outgoingIds: [], proofIds: [] },
        ]);
        await migrateLegacyConversations(api, deps);
        // ~5 повідомлень на людину при ліміті 20/хв у групі
        expect(deps.sleep).toHaveBeenCalledWith(20_000);
    });
});

describe("щоденні задачі", () => {
    function daily(hourKyivUtc: string) {
        const store = new Map<string, string>();
        const deps: Any = {
            redis: { set: vi.fn(async (key: string, value: string, ...args: Any[]) => {
                if (args.includes("NX") && store.has(key)) return null;
                store.set(key, value);
                return "OK";
            }) },
            threads: { archiveInactive: vi.fn(async () => undefined), dailyRefresh: vi.fn(async () => undefined) },
            repo: { deleteLinksOlderThan: vi.fn(async () => ({ count: 0 })) },
        };
        return { deps, now: new Date(hourKyivUtc) };
    }

    it("о 7-й за Києвом — архів, оновлення, прибирання старих пар", async () => {
        const { deps, now } = daily("2026-10-08T04:01:00Z");
        await expect(runDailySupportThreadJobs({} as Any, deps, now)).resolves.toBe(true);
        expect(deps.threads.archiveInactive).toHaveBeenCalled();
        expect(deps.threads.dailyRefresh).toHaveBeenCalled();
        expect(deps.repo.deleteLinksOlderThan).toHaveBeenCalledWith(new Date(now.getTime() - 90 * 86_400_000));
    });

    it("двічі за день — один раз", async () => {
        const { deps, now } = daily("2026-10-08T04:01:00Z");
        await runDailySupportThreadJobs({} as Any, deps, now);
        await expect(runDailySupportThreadJobs({} as Any, deps, new Date(now.getTime() + 60_000))).resolves.toBe(false);
        expect(deps.threads.dailyRefresh).toHaveBeenCalledTimes(1);
    });

    it("не о 7-й — нічого", async () => {
        const { deps } = daily("2026-10-08T09:00:00Z");
        await expect(runDailySupportThreadJobs({} as Any, deps, new Date("2026-10-08T09:00:00Z"))).resolves.toBe(false);
    });
});

describe("цикл кожні 5 хвилин", () => {
    it("недороблений перехід повторюється, поки не позначений «готово»", async () => {
        const { deps, api, repo, store } = setup([{ userId: "broken", topics: [], ticketIds: [1], outgoingIds: [], proofIds: [] }]);
        const daily: Any = { redis: { set: vi.fn(async () => null) }, threads: {}, repo: {} };
        await runSupportThreadTick(api, deps, daily, new Date("2026-10-08T09:00:00Z"));
        await runSupportThreadTick(api, deps, daily, new Date("2026-10-08T09:05:00Z"));
        expect(repo.listLegacyActive).toHaveBeenCalledTimes(2);
        expect(store.has("support:threads:migrated:v1")).toBe(false);
    });

    it("збій переходу не зриває щоденні задачі", async () => {
        const { deps, api, repo } = setup([]);
        repo.listLegacyActive.mockRejectedValue(new Error("db down"));
        const daily: Any = {
            redis: { set: vi.fn(async () => "OK") },
            threads: { archiveInactive: vi.fn(async () => undefined), dailyRefresh: vi.fn(async () => undefined) },
            repo: { deleteLinksOlderThan: vi.fn(async () => ({ count: 0 })) },
        };
        await runSupportThreadTick(api, deps, daily, new Date("2026-10-08T04:01:00Z"));
        expect(daily.threads.dailyRefresh).toHaveBeenCalled();
    });
});
