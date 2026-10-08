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
        listAll: vi.fn(async () => [...threads.values()]),
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
        icons: async () => ({ WAITING: "", ANSWERED: "", ESCALATED: "e-id", ARCHIVED: "r-id" }),
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
        expect(api.createForumTopic).toHaveBeenCalledWith(-1001234, "Бланк · Lviv · Dragon Park 2", {});
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

describe("лок створення зайнятий", () => {
    it("чекає, поки інший процес створить тему, а не падає", async () => {
        const { service, api, repo } = setup({
            lock: async () => { throw new Error("Support conversation for u1 is being created by another process"); },
            sleep: async () => undefined,
        });
        const created = { id: "other", userId: "u1", chatId: -1001234n, topicId: 99 };
        repo.findByUserId.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(created as Row);
        await expect(service.ensureThread(api, "u1")).resolves.toBe(created);
        expect(api.createForumTopic).not.toHaveBeenCalled();
    });

    it("інший процес так і не створив — помилка", async () => {
        const { service, api } = setup({
            lock: async () => { throw new Error("Support conversation for u1 is being created by another process"); },
            sleep: async () => undefined,
        });
        await expect(service.ensureThread(api, "u1")).rejects.toThrow("another process");
    });
});

describe("статус-іконка", () => {
    it("чекає ↔ відповіли — іконку не чіпає: зміна іконки пише в тему службовий рядок", async () => {
        const { service, api } = setup();
        const thread = await service.ensureThread(api, "u1");
        const waiting = await service.applyStatus(api, thread, { kind: "staff_question" });
        await service.applyStatus(api, waiting, { kind: "support_reply", actorTelegramId: 5n });
        expect(waiting.status).toBe("WAITING");
        expect(api.editForumTopic).not.toHaveBeenCalled();
    });

    it("покликали — 👀, повернули — іконку знято", async () => {
        const { service, api } = setup();
        const thread = await service.ensureThread(api, "u1");
        const escalated = await service.applyStatus(api, thread, { kind: "escalated", targetTelegramId: 1n });
        expect(api.editForumTopic).toHaveBeenLastCalledWith(-1001234, 77, { icon_custom_emoji_id: "e-id" });
        await service.applyStatus(api, escalated, { kind: "back_to_support", hasUnansweredQuestion: true });
        expect(api.editForumTopic).toHaveBeenLastCalledWith(-1001234, 77, { icon_custom_emoji_id: "" });
    });

    it("той самий статус не чіпає тему", async () => {
        const { service, api } = setup();
        const thread = await service.ensureThread(api, "u1");
        const escalated = await service.applyStatus(api, thread, { kind: "escalated", targetTelegramId: 1n });
        api.editForumTopic.mockClear();
        await service.applyStatus(api, escalated, { kind: "staff_question" });
        expect(api.editForumTopic).not.toHaveBeenCalled();
    });

    it("помилка Telegram на іконці не ламає статус", async () => {
        const { service, api } = setup();
        const thread = await service.ensureThread(api, "u1");
        api.editForumTopic.mockRejectedValueOnce(new Error("Bad Request: TOPIC_NOT_MODIFIED"));
        await expect(service.applyStatus(api, thread, { kind: "escalated", targetTelegramId: 1n })).resolves.toMatchObject({ status: "ESCALATED" });
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

describe("звільнена пише після архіву", () => {
    it("повторно в архів не кладемо і рядок не дублюємо", async () => {
        const { service, api, people, repo } = setup();
        const thread = await service.ensureThread(api, "u1");
        people.getPerson.mockResolvedValue({ ...(await people.getPerson()), isActive: false });
        await service.archiveInactive(api);
        // вона написала — тема знову чекає відповіді
        repo.threads.set(thread.id, { ...repo.threads.get(thread.id), status: "WAITING" });
        api.sendMessage.mockClear();
        await service.archiveInactive(api);
        expect(repo.threads.get(thread.id)!.status).toBe("WAITING");
        expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("картка показує звільнення і тоді, коли тема чекає відповіді", async () => {
        const { service, api, people, repo } = setup();
        const thread = await service.ensureThread(api, "u1");
        people.getPerson.mockResolvedValue({ ...(await people.getPerson()), isActive: false });
        await service.archiveInactive(api);
        repo.threads.set(thread.id, { ...repo.threads.get(thread.id), status: "WAITING" });
        api.editMessageText.mockClear();
        await service.refreshCard(api, repo.threads.get(thread.id)!);
        expect(api.editMessageText.mock.calls[0]![2].split("\n")[0]).toMatch(/^📦 Employment ended /);
    });
});

describe("повернулась на роботу", () => {
    it("тема виходить з архіву, картка знову показує сьогодні", async () => {
        const { service, api, people, repo } = setup();
        const thread = await service.ensureThread(api, "u1");
        const active = await people.getPerson();
        people.getPerson.mockResolvedValue({ ...active, isActive: false });
        await service.archiveInactive(api);
        expect(repo.threads.get(thread.id)!.status).toBe("ARCHIVED");
        people.getPerson.mockResolvedValue(active);
        api.editMessageText.mockClear();
        await service.archiveInactive(api);
        expect(repo.threads.get(thread.id)!.status).toBe("ANSWERED");
        expect(repo.threads.get(thread.id)!.archivedAt).toBeNull();
        expect(api.editMessageText.mock.calls.at(-1)![2].split("\n")[0]).toMatch(/^📍 Today /);
    });

    it("картка не показує звільнення активній, навіть якщо позначка ще не знята", async () => {
        const { service, api, repo } = setup();
        const thread = await service.ensureThread(api, "u1");
        repo.threads.set(thread.id, { ...repo.threads.get(thread.id), archivedAt: new Date("2026-10-01T10:00:00Z") });
        api.editMessageText.mockClear();
        await service.refreshCard(api, repo.threads.get(thread.id)!);
        expect(api.editMessageText.mock.calls[0]![2].split("\n")[0]).toMatch(/^📍 Today /);
    });
});

describe("дорогий опис людини", () => {
    it("картка і рядок «сьогодні» в один момент читають графік один раз", async () => {
        const { service, api, people, repo } = setup();
        // тема вже є (створена раніше, інший процес) — кеш опису порожній
        const thread = await repo.create({ userId: "u1", chatId: -1001234n, topicId: 77, title: "Бланк", cardMessageId: 5 });
        const fresh = { ...thread, cardDay: null, noticeDay: null };
        await service.refreshCardIfStale(api, fresh);
        await service.noticeIfAway(api, fresh);
        expect(people.todayShift).toHaveBeenCalledTimes(1);
    });

    it("непередбачена помилка оновлення картки не змушує читати графік на кожне повідомлення", async () => {
        const { service, api, repo } = setup();
        const thread = await service.ensureThread(api, "u1");
        repo.threads.set(thread.id, { ...repo.threads.get(thread.id), cardDay: null });
        api.editMessageText.mockRejectedValueOnce(new Error("Bad Request: something odd"));
        await service.refreshCard(api, repo.threads.get(thread.id)!);
        expect(repo.threads.get(thread.id)!.cardDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});

describe("посилання на тему", () => {
    it("t.me/c без -100", () => {
        expect(topicLink(-1001234n, 77)).toBe("https://t.me/c/1234/77");
    });
});
