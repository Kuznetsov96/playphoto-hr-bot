import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, Context } from "grammy";

/** /start от BLOCKER-кандидатки: возврат на шаг воронки и экран статуса «З поверненням!». */

const findWithProfilesByTelegramId = vi.fn();
const findByTelegramId = vi.fn();
const updateMany = vi.fn();
const returnBlockedCandidateIfNeeded = vi.fn();
const reactivateUnderageCandidateIfEligible = vi.fn();
const showCandidateStatus = vi.fn();
const startScreening = vi.fn();
const candidateDataFromRecord = vi.fn((c: unknown) => ({ data: c }));

vi.mock("../../repositories/user-repository.js", () => ({ userRepository: { findWithProfilesByTelegramId } }));
vi.mock("../../db/core.js", () => ({ default: { user: { updateMany } } }));
vi.mock("../../utils/screen-manager.js", () => ({ ScreenManager: { renderScreen: vi.fn() } }));
vi.mock("../../utils/cleanup.js", () => ({ cleanupMessages: vi.fn(), trackMessage: vi.fn() }));
vi.mock("../../middleware/role-check.js", () => ({
    requireRole: vi.fn(),
    getUserAdminRole: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../utils/command-manager.js", () => ({ updateUserCommands: vi.fn() }));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn(), logAuditEvent: vi.fn() }));
vi.mock("../../modules/staff/handlers/menu.js", () => ({ showStaffHub: vi.fn() }));
vi.mock("../../modules/candidate/handlers/index.js", () => ({ candidateDataFromRecord, startScreening }));
vi.mock("../../repositories/candidate-repository.js", () => ({ candidateRepository: { findByTelegramId } }));
vi.mock("../../services/blocker-return-service.js", () => ({ returnBlockedCandidateIfNeeded }));
vi.mock("../../services/underage-reactivation-service.js", () => ({ reactivateUnderageCandidateIfEligible }));
vi.mock("../../utils/candidate-ui.js", () => ({ showCandidateStatus }));

const { commandHandlers } = await import("../commands.js");

const api = new Api("0:test");
api.config.use(async () => ({ ok: true, result: true }) as any);
const me = { id: 1, is_bot: true, first_name: "Bot", username: "bot" } as any;
const from = { id: 111, is_bot: false, first_name: "Іра" };
const chat = { id: 111, type: "private" as const, first_name: "Іра" };
let session: any;

async function start() {
    const ctx = new Context({
        update_id: 1,
        message: {
            message_id: 70, date: 0, chat, from, text: "/start",
            entities: [{ type: "bot_command", offset: 0, length: 6 }],
        },
    } as any, api, me) as any;
    ctx.session = session;
    await commandHandlers.middleware()(ctx, async () => { });
}

const blocker = { id: "c1", status: "BLOCKER", currentStep: "INTERVIEW", user: { id: "u1" } };

beforeEach(() => {
    vi.clearAllMocks();
    session = { step: "idle", navStack: [], messagesToDelete: [] };
    updateMany.mockResolvedValue({ count: 1 });
    findWithProfilesByTelegramId.mockResolvedValue({ id: "u1", candidate: blocker });
    reactivateUnderageCandidateIfEligible.mockResolvedValue(null);
});

describe("/start от BLOCKER", () => {
    it("возвращает на шаг воронки и показывает статус с welcomeBack", async () => {
        const returned = { id: "c1", status: "WAITLIST_HR", currentStep: "INTERVIEW" };
        returnBlockedCandidateIfNeeded.mockResolvedValue({ candidate: returned, mode: "INTERVIEW_WAITLIST" });

        await start();

        expect(returnBlockedCandidateIfNeeded).toHaveBeenCalledWith(blocker, "start_command");
        expect(showCandidateStatus).toHaveBeenCalledWith(expect.anything(), returned, { welcomeBack: true });
        expect(startScreening).not.toHaveBeenCalled();
    });

    it("RESUME_SCREENING запускает анкету, как у underage", async () => {
        const returned = { id: "c1", status: "SCREENING" };
        returnBlockedCandidateIfNeeded.mockResolvedValue({ candidate: returned, mode: "RESUME_SCREENING" });

        await start();

        expect(candidateDataFromRecord).toHaveBeenCalledWith(returned);
        expect(startScreening).toHaveBeenCalledTimes(1);
        expect(showCandidateStatus).not.toHaveBeenCalled();
    });

    it("не BLOCKER — возврат не вызывается, статус без welcomeBack", async () => {
        const active = { id: "c1", status: "SCREENING", user: { id: "u1" } };
        findWithProfilesByTelegramId.mockResolvedValue({ id: "u1", candidate: active });

        await start();

        expect(returnBlockedCandidateIfNeeded).not.toHaveBeenCalled();
        expect(showCandidateStatus).toHaveBeenCalledWith(expect.anything(), active, undefined);
    });
});
