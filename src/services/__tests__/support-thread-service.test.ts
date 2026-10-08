import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { SupportThreadService, topicLink } = await import("../support-thread-service.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

function fakeRepo() {
    const threads = new Map<string, Row>();
    let seq = 0;
    return {
        threads,
        findByUserId: vi.fn(async (userId: string) => [...threads.values()].find(t => t.userId === userId) ?? null),
        findById: vi.fn(async (id: string) => threads.get(id) ?? null),
        create: vi.fn(async (data: Row) => {
            const row = { id: `t${++seq}`, status: "ANSWERED", escalatedToTelegramId: null, cardMessageId: null, cardDay: null, noticeDay: null, ...data };
            threads.set(row.id, row);
            return row;
        }),
        update: vi.fn(async (id: string, data: Row) => {
            const row = { ...threads.get(id)!, ...data };
            threads.set(id, row);
            return row;
        }),
        listByStatusNot: vi.fn(async (status: string) => [...threads.values()].filter(t => t.status !== status)),
        listCollidingSurnames: vi.fn(async () => new Set<string>()),
    };
}

function fakeApi() {
    let messageId = 100;
    return {
        createForumTopic: vi.fn(async () => ({ message_thread_id: 77, name: "x" })),
        editForumTopic: vi.fn(async () => true),
        sendMessage: vi.fn(async () => ({ message_id: ++messageId })),
        editMessageText: vi.fn(async () => true),
        pinChatMessage: vi.fn(async () => true),
    };
}

const DRAGON_2 = { id: "dp2", name: "Dragon Park 2", branch: null, city: "Lviv" };
const DRAGON_1 = { id: "dp1", name: "Dragon Park", branch: null, city: "Lviv" };

function setup(overrides: Partial<Record<string, any>> = {}) {
    const repo = fakeRepo();
    const api = fakeApi();
    const people = {
        getPerson: vi.fn(async () => ({
            userId: "u1", staffId: "s1", fullName: "Бланк Анастасія Ігорівна", surnameNameDot: "Бланк А.",
            phone: "+380", username: "blank", isActive: true, homeLocation: DRAGON_1,
        })),
        recentShiftLocations: vi.fn(async () => [DRAGON_2, DRAGON_2, DRAGON_1]),
        todayShift: vi.fn(async () => null as null | { location: typeof DRAGON_1; time: string | null }),
    };
    const service = new SupportThreadService({
        repo: repo as any,
        people,
        lock: async (_userId: string, fn: () => Promise<any>) => fn(),
        chatId: () => -1001234,
        icons: async () => ({ WAITING: "w-id", ANSWERED: "a-id", ESCALATED: "e-id", ARCHIVED: "r-id" }),
        sleep: async () => undefined,
        callTargets: () => ({ kuznetsov: 1, hupalova: 2 }),
        ...overrides,
    });
    return { service, repo, api: api as any, people };
}

beforeEach(() => vi.clearAllMocks());

describe("створення теми", () => {
    it("назва з найчастішої точки змін, не з профілю", async () => {
        const { service, api } = setup();
        await service.ensureThread(api, "u1");
        expect(api.createForumTopic).toHaveBeenCalledWith(-1001234, "Бланк · Lviv · Dragon Park 2", { icon_custom_emoji_id: "a-id" });
    });

    it("картка закріплена і з кнопками покликати", async () => {
        const { service, api, repo } = setup();
        const thread = await service.ensureThread(api, "u1");
        const [, text, options] = api.sendMessage.mock.calls[0];
        expect(api.sendMessage.mock.calls[0][0]).toBe(-1001234);
        expect(options.message_thread_id).toBe(77);
        expect(text.split("\n")[0]).toMatch(/^📍 Today \d\d\.\d\d: no shift$/);
        expect(JSON.stringify(options.reply_markup)).toContain(`sth:c:${thread.id}:k`);
        expect(JSON.stringify(options.reply_markup)).toContain(`sth:c:${thread.id}:h`);
        expect(api.pinChatMessage).toHaveBeenCalledWith(-1001234, 101, { disable_notification: true });
        expect(repo.threads.get(thread.id)!.cardMessageId).toBe(101);
    });

    it("друга тема для тієї самої людини не створюється", async () => {
        const { service, api } = setup();
        await service.ensureThread(api, "u1");
        await service.ensureThread(api, "u1");
        expect(api.createForumTopic).toHaveBeenCalledTimes(1);
    });

    it("два одночасні виклики під локом — одна тема", async () => {
        let chain = Promise.resolve();
        const lock = (_u: string, fn: () => Promise<any>) => {
            const run = chain.then(fn);
            chain = run.then(() => undefined, () => undefined);
            return run;
        };
        const { service, api } = setup({ lock });
        await Promise.all([service.ensureThread(api, "u1"), service.ensureThread(api, "u1")]);
        expect(api.createForumTopic).toHaveBeenCalledTimes(1);
    });

    it("без налаштованих цілей кнопок покликати немає", async () => {
        const { service, api } = setup({ callTargets: () => ({ kuznetsov: undefined, hupalova: undefined }) });
        await service.ensureThread(api, "u1");
        expect(api.sendMessage.mock.calls[0][2].reply_markup).toBeUndefined();
    });
});

describe("статус-іконка", () => {
    it("зміна статусу міняє іконку", async () => {
        const { service, api } = setup();
        const thread = await service.ensureThread(api, "u1");
        const updated = await service.applyStatus(api, thread, { kind: "staff_question" });
        expect(updated.status).toBe("WAITING");
        expect(api.editForumTopic).toHaveBeenCalledWith(-1001234, 77, { icon_custom_emoji_id: "w-id" });
    });

    it("той самий статус не чіпає тему", async () => {
        const { service, api } = setup();
        const thread = await service.ensureThread(api, "u1");
        const waiting = await service.applyStatus(api, thread, { kind: "staff_question" });
        api.editForumTopic.mockClear();
        await service.applyStatus(api, waiting, { kind: "staff_question" });
        expect(api.editForumTopic).not.toHaveBeenCalled();
    });

    it("помилка Telegram на іконці не ламає статус", async () => {
        const { service, api } = setup();
        const thread = await service.ensureThread(api, "u1");
        api.editForumTopic.mockRejectedValueOnce(new Error("Bad Request: TOPIC_NOT_MODIFIED"));
        await expect(service.applyStatus(api, thread, { kind: "staff_question" })).resolves.toMatchObject({ status: "WAITING" });
    });
});

describe("картка", () => {
    it("«message is not modified» ігнорується", async () => {
        const { service, api } = setup();
        const thread = await service.ensureThread(api, "u1");
        api.editMessageText.mockRejectedValueOnce(new Error("Bad Request: message is not modified"));
        await expect(service.refreshCard(api, thread)).resolves.toBeUndefined();
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("видалену картку бот публікує і закріплює знову", async () => {
        const { service, api, repo } = setup();
        const thread = await service.ensureThread(api, "u1");
        api.editMessageText.mockRejectedValueOnce(new Error("Bad Request: message to edit not found"));
        await service.refreshCard(api, repo.threads.get(thread.id)!);
        expect(api.sendMessage).toHaveBeenCalledTimes(2);
        expect(api.pinChatMessage).toHaveBeenCalledTimes(2);
    });

    it("сьогоднішня зміна в першому рядку", async () => {
        const { service, api, people } = setup();
        people.todayShift.mockResolvedValue({ location: DRAGON_1, time: "10:00-20:00" });
        const thread = await service.ensureThread(api, "u1");
        expect(api.sendMessage.mock.calls[0][1].split("\n")[0]).toMatch(/^📍 Today \d\d\.\d\d: Lviv · Dragon Park · 10:00-20:00$/);
        expect(thread).toBeTruthy();
    });
});

describe("рядок «сьогодні на іншій точці»", () => {
    it("пишеться раз на день, коли зміна не на основній точці", async () => {
        const { service, api, people, repo } = setup();
        people.todayShift.mockResolvedValue({ location: DRAGON_1, time: null });
        const thread = await service.ensureThread(api, "u1");
        api.sendMessage.mockClear();
        await service.noticeIfAway(api, repo.threads.get(thread.id)!);
        await service.noticeIfAway(api, repo.threads.get(thread.id)!);
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
        expect(api.sendMessage.mock.calls[0][1]).toBe("📍 Today at Lviv · Dragon Park (not the main point)");
    });

    it("на основній точці — нічого", async () => {
        const { service, api, people, repo } = setup();
        people.todayShift.mockResolvedValue({ location: DRAGON_2, time: null });
        const thread = await service.ensureThread(api, "u1");
        api.sendMessage.mockClear();
        await service.noticeIfAway(api, repo.threads.get(thread.id)!);
        expect(api.sendMessage).not.toHaveBeenCalled();
    });
});

describe("видалена тема", () => {
    it("створюється нова, з поясненням і карткою", async () => {
        const { service, api } = setup();
        const thread = await service.ensureThread(api, "u1");
        api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 88, name: "x" });
        const recreated = await service.recreateTopic(api, thread);
        expect(recreated.topicId).toBe(88);
        const texts = api.sendMessage.mock.calls.map((c: any[]) => c[1]);
        expect(texts).toContain("⚠️ Previous topic was deleted — history is in the archive.");
    });
});

describe("звільнення", () => {
    it("тема йде в архів один раз, з рядком і карткою", async () => {
        const { service, api, people, repo } = setup();
        const thread = await service.ensureThread(api, "u1");
        people.getPerson.mockResolvedValue({ ...(await people.getPerson()), isActive: false });
        api.sendMessage.mockClear();
        await service.archiveInactive(api);
        await service.archiveInactive(api);
        expect(repo.threads.get(thread.id)!.status).toBe("ARCHIVED");
        const texts = api.sendMessage.mock.calls.map((c: any[]) => c[1]);
        expect(texts.filter((t: string) => t.startsWith("📦 Employment ended"))).toHaveLength(1);
    });
});

describe("посилання на тему", () => {
    it("t.me/c без -100", () => {
        expect(topicLink(-1001234n, 77)).toBe("https://t.me/c/1234/77");
    });
});
