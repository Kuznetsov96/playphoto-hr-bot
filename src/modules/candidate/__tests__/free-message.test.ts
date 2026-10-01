import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer, Context } from "grammy";

/**
 * Повідомлення кандидатки поза анкетою (аудит 01.10.2026): воно вже пішло в
 * тред HR, тож бот не стирає його і не відповідає «Не зрозумів», а каже
 * «передали команді» — не частіше разу на 3 год.
 */
const findByTelegramId = vi.fn();
vi.mock("../../../repositories/candidate-repository.js", () => ({
    candidateRepository: { findByTelegramId },
}));

const redisSet = vi.fn();
vi.mock("../../../core/redis.js", () => ({ redis: { set: (...a: unknown[]) => redisSet(...a) } }));

const isMirrored = vi.fn();
vi.mock("../../../middleware/recruiting-incoming.js", () => ({
    isMirroredCandidateMessage: (...a: unknown[]) => isMirrored(...a),
}));

const startScreening = vi.fn();
vi.mock("../handlers/index.js", () => ({ candidateHandlers: new Composer(), startScreening }));

vi.mock("../../../menus/candidate.js", () => ({
    candidateGenderMenu: new Composer(),
    candidateCityMenu: new Composer(),
    candidateLocationMenu: new Composer(),
    candidateAppearanceMenu: new Composer(),
    candidateSourceMenu: new Composer(),
}));

const showCandidateStatus = vi.fn();
vi.mock("../../../utils/candidate-ui.js", () => ({ showCandidateStatus }));

const { candidateModule } = await import("../index.js");
const { CANDIDATE_TEXTS } = await import("../../../constants/candidate-texts.js");

const sendMessage = vi.fn();

function makeCtx(message: Record<string, unknown>, step?: string) {
    const update = {
        update_id: 1,
        message: { message_id: 5, date: 1, chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false, first_name: "A" }, ...message },
    };
    const ctx = new Context(update as never, { sendMessage } as never, { id: 1, is_bot: true } as never) as Context & { session: unknown };
    ctx.session = { step };
    return ctx;
}

const run = (ctx: Context) => candidateModule.middleware()(ctx as never, async () => {});

beforeEach(() => {
    vi.clearAllMocks();
    sendMessage.mockResolvedValue({ message_id: 9 });
    findByTelegramId.mockResolvedValue({ id: "cand-1", status: "REJECTED" });
    isMirrored.mockReturnValue(true);
    redisSet.mockResolvedValue("OK");
});

describe("candidate free message outside the questionnaire", () => {
    it("відповідає «передали команді», а не «Не зрозумів»", async () => {
        await run(makeCtx({ text: "чому відмова?" }, "idle"));

        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0]?.[1]).toBe(CANDIDATE_TEXTS["candidate-message-forwarded"]);
        expect(showCandidateStatus).not.toHaveBeenCalled();
        expect(redisSet).toHaveBeenCalledWith("candidate:forwarded-ack:42", "1", "EX", 10800, "NX");
    });

    it("друге повідомлення протягом 3 год — без відповіді", async () => {
        redisSet.mockResolvedValue(null);

        await run(makeCtx({ text: "дякую" }, "idle"));

        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("недзеркальоване (стікер) — тиша, без обіцянки", async () => {
        isMirrored.mockReturnValue(false);

        await run(makeCtx({ sticker: { file_id: "s" } }, "idle"));

        expect(sendMessage).not.toHaveBeenCalled();
        expect(showCandidateStatus).not.toHaveBeenCalled();
    });

    it("посеред анкети не-відповідь повертає поточне питання", async () => {
        await run(makeCtx({ voice: { file_id: "v" } }, "screening_city"));

        expect(startScreening).toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("HIRED (не дзеркалиться) — колишній екран статусу", async () => {
        findByTelegramId.mockResolvedValue({ id: "cand-1", status: "HIRED" });

        await run(makeCtx({ text: "привіт" }, "idle"));

        expect(sendMessage.mock.calls[0]?.[1]).toBe(CANDIDATE_TEXTS["candidate-error-unknown-message"]);
        expect(showCandidateStatus).toHaveBeenCalled();
    });
});
