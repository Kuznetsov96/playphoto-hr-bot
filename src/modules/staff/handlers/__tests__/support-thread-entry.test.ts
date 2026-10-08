import { beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const relayStaffMessage = vi.fn<(...args: any[]) => Promise<string>>(async () => "delivered");
const getTaskById = vi.fn();
const getSubmissionById = vi.fn();
const findWithStaffProfileByTelegramId = vi.fn();

vi.mock("../../../../core/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../../../services/support-thread-runtime.js", () => ({ supportRelayService: { relayStaffMessage } }));
vi.mock("../../../../services/task-service.js", () => ({ taskService: { getTaskById } }));
vi.mock("../../../../services/task-proof-service.js", () => ({ taskProofService: { getSubmissionById } }));
vi.mock("../../../../repositories/user-repository.js", () => ({ userRepository: { findWithStaffProfileByTelegramId } }));
vi.mock("../../../../constants/staff-texts.js", () => ({
    STAFF_TEXTS: { "broadcast-ans-decline": "DECLINE-NOTED", "staff-btn-home": "Меню", "support-thread-unsupported": "UNSUPPORTED" },
}));

const { handleStaffThreadMessage } = await import("../support-thread-entry.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function ctx(session: Any = {}, message: Any = { message_id: 11, text: "Питання" }) {
    return {
        chat: { id: 555, type: "private" },
        from: { id: 555 },
        session: { step: "idle", ...session },
        message,
        api: {},
        reply: vi.fn(async () => ({})),
    } as Any;
}

beforeEach(() => {
    vi.clearAllMocks();
    findWithStaffProfileByTelegramId.mockResolvedValue({ id: "u1", staffProfile: { id: "s1", isActive: true } });
});

describe("повідомлення співробітниці йде в її тему", () => {
    it("вільний текст без контексту", async () => {
        await expect(handleStaffThreadMessage(ctx())).resolves.toBe(true);
        expect(relayStaffMessage).toHaveBeenCalledWith({}, expect.objectContaining({ userId: "u1", chatId: 555, contexts: [] }));
    });

    it("команда не пересилається", async () => {
        await expect(handleStaffThreadMessage(ctx({}, { message_id: 1, text: "/start" }))).resolves.toBe(false);
        expect(relayStaffMessage).not.toHaveBeenCalled();
    });

    it("не співробітниця — не наше", async () => {
        findWithStaffProfileByTelegramId.mockResolvedValue({ id: "u2", staffProfile: null });
        await expect(handleStaffThreadMessage(ctx())).resolves.toBe(false);
    });

    it("звільнена теж пише в тему", async () => {
        findWithStaffProfileByTelegramId.mockResolvedValue({ id: "u1", staffProfile: { id: "s1", isActive: false } });
        await expect(handleStaffThreadMessage(ctx())).resolves.toBe(true);
        expect(relayStaffMessage).toHaveBeenCalled();
    });

    it("уточнення по задачі — контекст задачі, сесія чиститься", async () => {
        getTaskById.mockResolvedValue({ id: "task1", taskText: "<b>Сфотографуй</b> вітрину", workDate: new Date("2026-10-08T00:00:00Z"), locationName: "Dragon Park 2", city: "Lviv" });
        const c = ctx({ step: "create_ticket", clarificationTaskId: "task1" });
        await handleStaffThreadMessage(c);
        const [context] = relayStaffMessage.mock.calls[0]![1].contexts;
        expect(context.topicHtml).toBe("❓ <b>Task question</b> · 08.10 · Dragon Park 2\n<i>Сфотографуй вітрину</i>");
        expect(context.contextText).toBe("Завдання 08.10: Сфотографуй вітрину");
        expect(c.session.clarificationTaskId).toBeUndefined();
        expect(c.session.step).toBe("idle");
    });

    it("уточнення скасували, а написала вона через дні — контексту задачі немає", async () => {
        const c = ctx({ step: "idle", clarificationTaskId: "task1" });
        await handleStaffThreadMessage(c);
        expect(getTaskById).not.toHaveBeenCalled();
        expect(relayStaffMessage.mock.calls[0]![1].contexts).toEqual([]);
        expect(c.session.clarificationTaskId).toBeUndefined();
    });

    it("непідтримуваний формат — їй кажуть, контекст із сесії не губиться", async () => {
        const c = ctx({ step: "create_ticket", clarificationTaskId: "task1" }, { message_id: 30, story: {} });
        await expect(handleStaffThreadMessage(c)).resolves.toBe(true);
        expect(relayStaffMessage).not.toHaveBeenCalled();
        expect(c.reply).toHaveBeenCalledWith("UNSUPPORTED");
        expect(c.session.clarificationTaskId).toBe("task1");
        expect(c.session.step).toBe("create_ticket");
    });

    it("службова подія (закріпила повідомлення) — мовчки, без «не вийде передати»", async () => {
        const c = ctx({}, { message_id: 31, pinned_message: {} });
        await expect(handleStaffThreadMessage(c)).resolves.toBe(true);
        expect(c.reply).not.toHaveBeenCalled();
        expect(relayStaffMessage).not.toHaveBeenCalled();
    });

    it("частина альбому лишає крок «пише в підтримку» — наступні частини не втечуть у чернетку звіту", async () => {
        const c = ctx({ step: "create_ticket" }, { message_id: 32, media_group_id: "g1", photo: [{}] });
        await handleStaffThreadMessage(c);
        expect(c.session.step).toBe("create_ticket");
    });

    it("відповідь на старе уточнення по звіту — контекст задачі зі звіту", async () => {
        getSubmissionById.mockResolvedValue({ id: "p1", taskId: "task1" });
        getTaskById.mockResolvedValue({ id: "task1", taskText: "Вітрина", workDate: null, locationName: null, city: null });
        const c = ctx({ step: "awaiting_task_proof_topic_reply_p1", taskProofFlow: { taskId: "task1", replySubmissionId: "p1" } });
        await handleStaffThreadMessage(c);
        expect(relayStaffMessage.mock.calls[0]![1].contexts[0].contextText).toBe("Завдання: Вітрина");
        expect(c.session.step).toBe("idle");
        expect(c.session.taskProofFlow?.replySubmissionId).toBeUndefined();
    });

    it("звернення з нагадування про зйомку — рядок зйомки", async () => {
        const c = ctx({ step: "create_ticket", shootSupportLine: { line: "Зйомка · <Олена> · сб 11.10", at: Date.now() } });
        await handleStaffThreadMessage(c);
        const [context] = relayStaffMessage.mock.calls[0]![1].contexts;
        expect(context.topicHtml).toBe("📸 <b>Shoot question</b>\nЗйомка · &lt;Олена&gt; · сб 11.10");
        expect(context.contextText).toBe("Зйомка · <Олена> · сб 11.10");
        expect(c.session.shootSupportLine).toBeUndefined();
    });

    it("заперечення розсилки — контекст і звичайне підтвердження, без «напиши деталі» вдруге", async () => {
        const c = ctx({ step: "broadcast_decline_reason", broadcastId: 42 });
        await handleStaffThreadMessage(c);
        const input = relayStaffMessage.mock.calls[0]![1] as Any;
        expect(input.contexts[0].topicHtml).toBe("📣 <b>Disagrees with broadcast #42</b>");
        expect(input.contexts[0].contextText).toBe("Розсилка #42");
        expect(c.reply).not.toHaveBeenCalled();
        expect(c.session.broadcastId).toBeUndefined();
        expect(c.session.step).toBe("idle");
    });

    it("відповідь на фінансове питання — контекст із питання", async () => {
        const c = ctx({}, { message_id: 12, text: "Було 200", reply_to_message: { message_id: 5, text: "Потрібне уточнення по фінансах\nЛокація: Leoland" } });
        await handleStaffThreadMessage(c);
        const [context] = relayStaffMessage.mock.calls[0]![1].contexts;
        expect(context.topicHtml).toBe("💰 <b>Finance audit reply</b>\n<i>Потрібне уточнення по фінансах\nЛокація: Leoland</i>");
    });
});
