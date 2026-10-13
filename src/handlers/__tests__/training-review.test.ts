import { beforeEach, describe, expect, it, vi } from "vitest";

const roleOf = vi.fn();
const postDecision = vi.fn();
const postFeedback = vi.fn();
const redisSet = vi.fn();
const redisGet = vi.fn();

vi.mock("../../core/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../config/callback-secret.js", () => ({ CALLBACK_SECRET: "test-secret" }));
vi.mock("../../core/redis.js", () => ({ redis: { set: redisSet, get: redisGet } }));
vi.mock("../../utils/bot-blocked.js", () => ({
    // Настоящий модуль тянет репозиторий и Prisma; предикат здесь сведён к тому же 403.
    isBotBlocked: (err: { error_code?: number }) => err?.error_code === 403,
}));
vi.mock("../../config/roles.js", () => ({ getAdminRoleByTelegramId: roleOf }));
vi.mock("../../services/aws-business-client.js", async () => {
    const actual = await vi.importActual<typeof import("../../services/aws-business-client.js")>(
        "../../services/aws-business-client.js",
    );
    return {
        ...actual,
        awsBusinessClient: {
            postTrainingReviewDecision: postDecision,
            postTrainingReviewFeedback: postFeedback,
        },
    };
});

const { AwsBusinessApiError } = await import("../../services/aws-business-client.js");
const { buildSignedCallback } = await import("../../utils/signed-callback.js");
const { handleTrainingCallback, handleTrainingFeedback } = await import("../training-review.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const REVIEW_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OWNER_ID = 1;
const STRANGER_ID = 999;
const signed = (code: string, payload: string) => buildSignedCallback(code, payload);

let answer: ReturnType<typeof vi.fn>;

function ctxFor(fromId: number, data: string): Any {
    answer = vi.fn(async () => true);
    return {
        callbackQuery: { data },
        from: { id: fromId },
        chat: { id: fromId, type: "private" },
        api: {},
        answerCallbackQuery: answer,
        editMessageText: vi.fn(),
        editMessageReplyMarkup: vi.fn(async () => true),
        reply: vi.fn(async () => ({ message_id: 55 })),
    };
}

function messageCtx(o: { from: number; replyTo?: number; text?: string; voice?: object; messageId: number }): Any {
    return {
        from: { id: o.from },
        chat: { id: o.from, type: "private" },
        message: {
            message_id: o.messageId,
            text: o.text,
            voice: o.voice,
            reply_to_message: o.replyTo ? { message_id: o.replyTo } : undefined,
        },
        api: { copyMessage: vi.fn(async () => ({})) },
        reply: vi.fn(async () => ({})),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    redisGet.mockResolvedValue(null);
});

describe("training review callbacks", () => {
    it("refuses a non-owner without calling the webapp", async () => {
        roleOf.mockReturnValue(null);
        await handleTrainingCallback(ctxFor(STRANGER_ID, signed("tpp", REVIEW_ID)));
        expect(postDecision).not.toHaveBeenCalled();
        expect(answer).toHaveBeenCalledWith({ text: "Only the owner can decide.", show_alert: true });
    });

    it("refuses a non-owner staff role", async () => {
        roleOf.mockReturnValue("SUPPORT");
        await handleTrainingCallback(ctxFor(STRANGER_ID, signed("tpp", REVIEW_ID)));
        expect(postDecision).not.toHaveBeenCalled();
    });

    it("passes: posts the decision, clears buttons and asks for feedback", async () => {
        roleOf.mockReturnValue("SUPER_ADMIN");
        postDecision.mockResolvedValue({ decision: "PASSED", candidateTelegramId: "42", candidateName: "Марія" });
        const ctx = ctxFor(OWNER_ID, signed("tpp", REVIEW_ID));
        await handleTrainingCallback(ctx);
        expect(postDecision).toHaveBeenCalledWith(REVIEW_ID, {
            decision: "PASSED",
            failedItems: [],
            reasonCode: null,
            reviewerTelegramId: String(OWNER_ID),
        });
        expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: { inline_keyboard: [] } });
        expect(redisSet).toHaveBeenCalledWith(
            "training:feedback:1:55",
            expect.stringContaining('"candidateTelegramId":"42"'),
            "EX",
            604800,
        );
    });

    it("co-founder may decide too", async () => {
        roleOf.mockReturnValue("CO_FOUNDER");
        postDecision.mockResolvedValue({ decision: "PASSED", candidateTelegramId: "42", candidateName: "Марія" });
        await handleTrainingCallback(ctxFor(OWNER_ID, signed("tpp", REVIEW_ID)));
        expect(postDecision).toHaveBeenCalled();
    });

    it("turns REVIEW_ALREADY_DECIDED into a calm alert", async () => {
        roleOf.mockReturnValue("SUPER_ADMIN");
        postDecision.mockRejectedValue(new AwsBusinessApiError(409, "REVIEW_ALREADY_DECIDED", "decided"));
        const ctx = ctxFor(OWNER_ID, signed("tpp", REVIEW_ID));
        await handleTrainingCallback(ctx);
        expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: { inline_keyboard: [] } });
        expect(answer).toHaveBeenCalledWith({ text: "Already decided.", show_alert: true });
    });

    it("other errors answer the button, keep it alive and do not prompt for feedback", async () => {
        roleOf.mockReturnValue("SUPER_ADMIN");
        postDecision.mockRejectedValue(new Error("boom"));
        const ctx = ctxFor(OWNER_ID, signed("tpp", REVIEW_ID));
        await handleTrainingCallback(ctx);
        expect(answer).toHaveBeenCalledWith({ text: "Could not save the decision. Try again.", show_alert: true });
        expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
        expect(redisSet).not.toHaveBeenCalled();
    });

    it("retry: toggles redraw without calling the webapp, send posts failed items 1-based", async () => {
        roleOf.mockReturnValue("SUPER_ADMIN");
        redisGet.mockResolvedValue(JSON.stringify({ checklist: ["A", "B", "C", "D", "E", "F"], candidateName: "Марія" }));
        const toggleCtx = ctxFor(OWNER_ID, signed("tpt", `${REVIEW_ID}.5`));
        await handleTrainingCallback(toggleCtx);
        expect(postDecision).not.toHaveBeenCalled();
        expect(toggleCtx.editMessageReplyMarkup).toHaveBeenCalled();
        postDecision.mockResolvedValue({ decision: "RETRY", candidateTelegramId: "42", candidateName: "Марія" });
        await handleTrainingCallback(ctxFor(OWNER_ID, signed("tps", `${REVIEW_ID}.5`)));
        expect(postDecision).toHaveBeenCalledWith(REVIEW_ID, {
            decision: "RETRY",
            failedItems: [1, 3],
            reasonCode: null,
            reviewerTelegramId: String(OWNER_ID),
        });
    });

    it("reject: reason index maps to the reason code and no feedback prompt", async () => {
        roleOf.mockReturnValue("SUPER_ADMIN");
        postDecision.mockResolvedValue({ decision: "REJECTED", candidateTelegramId: "42", candidateName: "Марія" });
        await handleTrainingCallback(ctxFor(OWNER_ID, signed("tpx", `${REVIEW_ID}.1`)));
        expect(postDecision).toHaveBeenCalledWith(REVIEW_ID, {
            decision: "REJECTED",
            failedItems: [],
            reasonCode: "CANDIDATE_DECLINED",
            reviewerTelegramId: String(OWNER_ID),
        });
        expect(redisSet).not.toHaveBeenCalled();
    });
});

describe("back button and answer ordering", () => {
    it("back redraws the original decision keyboard", async () => {
        roleOf.mockReturnValue("SUPER_ADMIN");
        const ctx = ctxFor(OWNER_ID, signed("tpk", REVIEW_ID));
        await handleTrainingCallback(ctx);
        const markup = ctx.editMessageReplyMarkup.mock.calls[0][0].reply_markup.inline_keyboard;
        expect(markup[0].map((b: Any) => b.text)).toEqual(["Passed", "Try again", "Reject"]);
        expect(postDecision).not.toHaveBeenCalled();
    });

    it("retry and reject screens carry a Back button within 64 bytes", async () => {
        roleOf.mockReturnValue("SUPER_ADMIN");
        redisGet.mockResolvedValue(JSON.stringify({ checklist: ["A", "B"], candidateName: "Марія" }));
        for (const data of [signed("tpr", REVIEW_ID), signed("tpj", REVIEW_ID)]) {
            const ctx = ctxFor(OWNER_ID, data);
            await handleTrainingCallback(ctx);
            const rows: Any[][] = ctx.editMessageReplyMarkup.mock.calls[0][0].reply_markup.inline_keyboard;
            const back = rows.flat().find((b) => b.text === "‹ Back");
            expect(back).toBeTruthy();
            expect(Buffer.byteLength(back.callback_data)).toBeLessThanOrEqual(64);
        }
    });

    it("rejects a forged back callback from a stranger", async () => {
        roleOf.mockReturnValue(undefined);
        const ctx = ctxFor(STRANGER_ID, signed("tpk", REVIEW_ID));
        await handleTrainingCallback(ctx);
        expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
    });

    it("already decided: answers before editing and survives a failing edit", async () => {
        roleOf.mockReturnValue("SUPER_ADMIN");
        postDecision.mockRejectedValue(new AwsBusinessApiError(409, "REVIEW_ALREADY_DECIDED", "decided"));
        const ctx = ctxFor(OWNER_ID, signed("tpp", REVIEW_ID));
        const order: string[] = [];
        ctx.answerCallbackQuery = vi.fn(async () => { order.push("answer"); return true; });
        ctx.editMessageReplyMarkup = vi.fn(async () => { order.push("edit"); throw new Error("message is not modified"); });
        await expect(handleTrainingCallback(ctx)).resolves.toBeUndefined();
        expect(order).toEqual(["answer", "edit"]);
    });
});

describe("owner feedback reply", () => {
    const stored = JSON.stringify({ reviewPublicId: REVIEW_ID, candidateTelegramId: "42", candidateName: "Марія" });

    it("copies a voice reply to the candidate and records it", async () => {
        roleOf.mockReturnValue("SUPER_ADMIN");
        redisGet.mockResolvedValue(stored);
        const ctx = messageCtx({ from: OWNER_ID, replyTo: 77, voice: { file_id: "OWNERVOICE" }, messageId: 90 });
        const next = vi.fn();
        await handleTrainingFeedback(ctx, next);
        expect(redisGet).toHaveBeenCalledWith("training:feedback:1:77");
        expect(ctx.api.copyMessage).toHaveBeenCalledWith(42, OWNER_ID, 90);
        expect(postFeedback).toHaveBeenCalledWith(REVIEW_ID, {
            reviewerTelegramId: String(OWNER_ID),
            telegramMessageId: "90",
            body: "🎙 Голосове повідомлення",
            attachment: { fileId: "OWNERVOICE", kind: "VOICE" },
        });
        expect(next).not.toHaveBeenCalled();
    });

    it("still confirms to the owner when recording fails after the relay", async () => {
        roleOf.mockReturnValue("SUPER_ADMIN");
        redisGet.mockResolvedValue(stored);
        postFeedback.mockRejectedValue(new Error("down"));
        const ctx = messageCtx({ from: OWNER_ID, replyTo: 77, text: "well done", messageId: 92 });
        await handleTrainingFeedback(ctx, vi.fn());
        expect(ctx.api.copyMessage).toHaveBeenCalled();
        expect(ctx.reply).toHaveBeenCalledWith("Sent to the candidate.");
    });

    it("tells the owner when the candidate blocked the bot and records nothing", async () => {
        roleOf.mockReturnValue("SUPER_ADMIN");
        redisGet.mockResolvedValue(stored);
        const ctx = messageCtx({ from: OWNER_ID, replyTo: 77, text: "well done", messageId: 93 });
        ctx.api.copyMessage = vi.fn(async () => {
            throw Object.assign(new Error("Forbidden: bot was blocked by the user"), { error_code: 403 });
        });
        await handleTrainingFeedback(ctx, vi.fn());
        expect(ctx.reply).toHaveBeenCalledWith("Could not deliver: she blocked the bot.");
        expect(postFeedback).not.toHaveBeenCalled();
    });

    it("passes through when the reply is not to a feedback prompt", async () => {
        roleOf.mockReturnValue("SUPER_ADMIN");
        redisGet.mockResolvedValue(null);
        const next = vi.fn();
        await handleTrainingFeedback(messageCtx({ from: OWNER_ID, replyTo: 77, text: "hi", messageId: 91 }), next);
        expect(next).toHaveBeenCalled();
        expect(postFeedback).not.toHaveBeenCalled();
    });

    it("passes through for a non-owner without touching redis", async () => {
        roleOf.mockReturnValue(null);
        const next = vi.fn();
        await handleTrainingFeedback(messageCtx({ from: STRANGER_ID, replyTo: 77, text: "hi", messageId: 93 }), next);
        expect(next).toHaveBeenCalled();
        expect(redisGet).not.toHaveBeenCalled();
    });

    it("passes through a message that is not a reply", async () => {
        roleOf.mockReturnValue("SUPER_ADMIN");
        const next = vi.fn();
        await handleTrainingFeedback(messageCtx({ from: OWNER_ID, text: "hi", messageId: 94 }), next);
        expect(next).toHaveBeenCalled();
    });
});
