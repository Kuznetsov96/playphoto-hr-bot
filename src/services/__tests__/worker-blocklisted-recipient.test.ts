import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Адресат из списка запрещённых Telegram ID: исходящий guard бросает BlockedRecipientError.
 * Циклы, где маркер «отправлено» ставится только после успеха, обязаны трактовать это как
 * «обработано»: иначе выборка вернёт ту же строку на каждом тике (раз в 5 минут) вечно.
 */
const state = vi.hoisted(() => ({
    decisionRows: [] as any[],
    interviewSlots: [] as any[],
    tasks: [] as any[],
}));

const candidateUpdate = vi.fn(async (id: string, data: any) => {
    const row = state.decisionRows.find(r => r.id === id);
    if (row) Object.assign(row, data);
    return row;
});
const archiveBlockedCandidate = vi.fn();
const updateInterviewSlot = vi.fn(async (id: string, data: any) => {
    const slot = state.interviewSlots.find(s => s.id === id);
    if (slot) Object.assign(slot, data);
});
const logBusinessEvent = vi.fn();
// Тик асинхронный (динамические import): ждём его конца по снятию лизы (скрипт с del).
let tickDone: (() => void) | null = null;

vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/audit-logger.js", () => ({ audit: vi.fn(), securityAudit: vi.fn() }));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent }));
vi.mock("../../core/redis.js", () => ({
    redis: {
        set: vi.fn().mockResolvedValue("OK"),
        eval: vi.fn(async (script: string) => {
            if (script.includes("'del'")) tickDone?.();
            return 1;
        }),
        get: vi.fn(),
    },
}));
vi.mock("../../db/core.js", () => {
    const model = new Proxy({}, { get: () => vi.fn().mockResolvedValue([]) });
    return { default: new Proxy({}, { get: () => model }) };
});
vi.mock("../../repositories/candidate-repository.js", () => ({
    candidateRepository: {
        // Как настоящий запрос: notificationSent:false
        findForDecisionNotification: vi.fn(async () => { return state.decisionRows.filter(r => !r.notificationSent); }),
        update: candidateUpdate,
        archiveBlockedCandidate,
        findById: vi.fn().mockResolvedValue(null),
    },
}));
vi.mock("../../repositories/interview-repository.js", () => ({
    interviewRepository: {
        // Как настоящий запрос: reminded6h:false
        findForReminder: vi.fn(async (field: string) =>
            field === "reminded6h" ? state.interviewSlots.filter(s => !s.reminded6h) : []),
        updateSlot: updateInterviewSlot,
    },
}));
vi.mock("../../repositories/training-repository.js", () => ({
    trainingRepository: { findForReminder: vi.fn().mockResolvedValue([]), updateSlot: vi.fn() },
}));
vi.mock("../../repositories/session-repository.js", () => ({ sessionRepository: { findByKey: vi.fn(), upsert: vi.fn() } }));
vi.mock("../../workers/invite-reminder.js", () => ({ processInviteReminders: vi.fn() }));
vi.mock("../interview-auto-complete.js", () => ({ autoCompleteOverdueInterviews: vi.fn() }));
vi.mock("../interview-slot-waitlist.js", () => ({ notifyWaitlistAboutNewSlots: vi.fn() }));
vi.mock("../task-service.js", () => ({
    taskService: {
        getStaffForMorningDigest: vi.fn().mockResolvedValue([]),
        getTasksNearingDeadline: vi.fn(async () => state.tasks.filter(t => !t.reminderSent)),
        getOverdueTasks: vi.fn().mockResolvedValue([]),
        markDigestSent: vi.fn(),
        markReminderSent: vi.fn(async (id: string) => { const t = state.tasks.find(x => x.id === id); if (t) t.reminderSent = true; }),
    },
}));

const { startWorker } = await import("../worker.js");
const { BlockedRecipientError } = await import("../telegram-blocklist-outgoing.js");

async function runOneTick(bot: any) {
    const finished = new Promise<void>(resolve => { tickDone = resolve; });
    const timer = await startWorker(bot);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 50);
    clearInterval(timer);
    await finished;
}

describe("worker: recipient on the Telegram blocklist is terminal", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        for (const m of [candidateUpdate, archiveBlockedCandidate, updateInterviewSlot, logBusinessEvent]) m.mockClear();
        state.decisionRows = [];
        state.interviewSlots = [];
    });
    afterEach(() => vi.useRealTimers());

    it("decision notification: marker set, no error event, not selected again on the next tick", async () => {
        state.decisionRows = [{
            id: "cand-1", hrDecision: "ACCEPTED", notificationSent: false, fullName: "Test",
            user: { telegramId: 838713502n },
        }];
        const bot = { api: { sendMessage: vi.fn().mockRejectedValue(new BlockedRecipientError()) } };

        await runOneTick(bot);
        expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
        expect(candidateUpdate).toHaveBeenCalledWith("cand-1", expect.objectContaining({ notificationSent: true }));
        expect(archiveBlockedCandidate).not.toHaveBeenCalled();
        expect(logBusinessEvent).not.toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));

        await runOneTick(bot);
        expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("6h interview reminder: reminded6h set, no error event, not selected again", async () => {
        state.interviewSlots = [{
            id: "slot-1", reminded6h: false, startTime: new Date(Date.now() + 3 * 3600_000),
            candidate: { id: "cand-2", fullName: "Test", user: { telegramId: 838713502n }, googleMeetLink: null },
        }];
        const bot = { api: { sendMessage: vi.fn().mockRejectedValue(new BlockedRecipientError()) } };

        await runOneTick(bot);
        expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
        expect(updateInterviewSlot).toHaveBeenCalledWith("slot-1", { reminded6h: true });
        expect(archiveBlockedCandidate).not.toHaveBeenCalled();
        expect(logBusinessEvent).not.toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));

        await runOneTick(bot);
        expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("task deadline reminder: markReminderSent called, not selected again", async () => {
        const { taskService } = await import("../task-service.js");
        const d = new Date(Date.now() + 30 * 60_000);
        const hhmm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
        state.tasks = [{ id: "t1", reminderSent: false, deadlineTime: hhmm, taskText: "x", staff: { user: { telegramId: 838713502n } } }];
        const bot = { api: { sendMessage: vi.fn().mockRejectedValue(new BlockedRecipientError()) } };

        await runOneTick(bot);
        expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
        expect(taskService.markReminderSent).toHaveBeenCalledWith("t1");

        await runOneTick(bot);
        expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    });
});
