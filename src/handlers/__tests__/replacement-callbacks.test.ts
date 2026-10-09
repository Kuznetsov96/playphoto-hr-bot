/**
 * Кнопки підміни. До 09.10.2026 ці обробники жили в handlers/index.ts без
 * жодного тесту: там 14 натискань «Це помилка, скасувати» підряд виглядали як
 * зламана кнопка, а відкат власника лишав копію заявки в боті FOUND.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));

const {
    answerOfferCallback,
    buildAcceptedOfferKeyboard,
    ownerRevertCallback,
    undoAcceptanceCallback,
} = await import("../replacement-callbacks.js");
const { buildSignedCallback } = await import("../../utils/signed-callback.js");

const OFFER_CARD =
    "🔔 Потрібна підміна на зміну — можливо, тобі підійде.\n\n" +
    "📍 Dragon Park (Lviv)\n📅 08.10\n🕐 14:00-21:00\n\n" +
    "Якщо не можеш — тисни «Не можу», нічого пояснювати не треба 💛";
const ACCEPTED_CARD =
    "✅ Ти виходиш на цю зміну\n\n📍 Dragon Park (Lviv)\n📅 08.10\n🕐 14:00-21:00\n\nПеревір «Мій графік» 💛";

type Button = { text: string; callback_data?: string };

function fakeCtx(data: string, messageText = OFFER_CARD) {
    return {
        from: { id: 5415140023 },
        callbackQuery: { data, message: { text: messageText } },
        api: { tag: "api" },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        editMessageText: vi.fn().mockResolvedValue(true),
        editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    };
}

function deps(overrides: Record<string, unknown> = {}) {
    return {
        findEmployeePublicId: vi.fn().mockResolvedValue("emp-kv"),
        answerOffer: vi.fn().mockResolvedValue("accepted"),
        undoAcceptance: vi.fn().mockResolvedValue("undone"),
        revertAsOwner: vi.fn().mockResolvedValue("reverted"),
        syncCanonicalRequest: vi.fn().mockResolvedValue(undefined),
        logWarn: vi.fn(),
        ...overrides,
    };
}

function buttonsOf(markup: unknown): Button[] {
    const keyboard = (markup as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ?? [];
    return keyboard.flat();
}

describe("answerOfferCallback", () => {
    const accept = () => buildSignedCallback("reploa", "offer-1");

    beforeEach(() => vi.clearAllMocks());

    it("rewrites the card to «Ти виходиш» and puts the undo button right on it", async () => {
        const ctx = fakeCtx(accept());
        const d = deps();

        await answerOfferCallback(ctx, "accept", d);

        expect(d.answerOffer).toHaveBeenCalledWith({
            offerPublicId: "offer-1",
            employeePublicId: "emp-kv",
            telegramId: 5415140023,
            answer: "accept",
        });
        const [text, options] = ctx.editMessageText.mock.calls[0]!;
        expect(text).toContain("Ти виходиш на цю зміну");
        expect(text).toContain("Dragon Park (Lviv)");
        const buttons = buttonsOf((options as { reply_markup: unknown }).reply_markup);
        expect(buttons.map((button) => button.text)).toEqual(["↩️ Це помилка, скасувати"]);
        expect(buttons[0]!.callback_data).toMatch(/^cb:replun:offer-1:/u);
    });

    it("keeps the undo button even when Telegram refuses to rewrite the card", async () => {
        const ctx = fakeCtx(accept());
        ctx.editMessageText.mockRejectedValue(new Error("message is not modified"));

        await answerOfferCallback(ctx, "accept", deps());

        const markup = (ctx.editMessageReplyMarkup.mock.calls[0]![0] as { reply_markup: unknown }).reply_markup;
        expect(buttonsOf(markup).map((button) => button.text)).toEqual(["↩️ Це помилка, скасувати"]);
    });

    it("clears every button after a decline", async () => {
        const ctx = fakeCtx(buildSignedCallback("replod", "offer-1"));

        await answerOfferCallback(ctx, "decline", deps({ answerOffer: vi.fn().mockResolvedValue("declined") }));

        const [text, options] = ctx.editMessageText.mock.calls[0]!;
        expect(text).toContain("Ти відмовилась");
        expect(buttonsOf((options as { reply_markup: unknown }).reply_markup)).toEqual([]);
    });

    it("shows an alert, not a toast, when the answer could not be saved", async () => {
        const ctx = fakeCtx(accept());

        await answerOfferCallback(ctx, "accept", deps({ answerOffer: vi.fn().mockResolvedValue("failed") }));

        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ show_alert: true }));
        expect(ctx.editMessageText).not.toHaveBeenCalled();
    });

    it("shows an alert when the photographer is not linked to the webapp", async () => {
        const ctx = fakeCtx(accept());
        const d = deps({ findEmployeePublicId: vi.fn().mockResolvedValue(null) });

        await answerOfferCallback(ctx, "accept", d);

        expect(d.answerOffer).not.toHaveBeenCalled();
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ show_alert: true }));
    });

    it("refuses a forged or stale callback without calling the backend", async () => {
        const ctx = fakeCtx("cb:reploa:offer-1:deadbeef");
        const d = deps();

        await answerOfferCallback(ctx, "accept", d);

        expect(d.answerOffer).not.toHaveBeenCalled();
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Це сповіщення вже неактуальне.");
    });
});

describe("undoAcceptanceCallback", () => {
    const undo = () => buildSignedCallback("replun", "offer-1");

    beforeEach(() => vi.clearAllMocks());

    it("turns the card into «Ти скасувала» so it stops saying the shift is hers", async () => {
        const ctx = fakeCtx(undo(), ACCEPTED_CARD);

        await undoAcceptanceCallback(ctx, deps());

        const [text, options] = ctx.editMessageText.mock.calls[0]!;
        expect(text).toBe("↩️ Ти скасувала — Dragon Park (Lviv), 08.10");
        expect(buttonsOf((options as { reply_markup: unknown }).reply_markup)).toEqual([]);
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Скасовано, зміна знову у пошуку 💛");
    });

    it("explains a closed window in an alert and takes the dead button away", async () => {
        const ctx = fakeCtx(undo(), ACCEPTED_CARD);

        await undoAcceptanceCallback(ctx, deps({ undoAcceptance: vi.fn().mockResolvedValue("window_closed") }));

        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
            text: "Час на скасування минув — напиши в підтримку.",
            show_alert: true,
        });
        const markup = (ctx.editMessageReplyMarkup.mock.calls[0]![0] as { reply_markup: unknown }).reply_markup;
        expect(buttonsOf(markup).map((button) => button.text)).toEqual(["🗓 Мій графік"]);
        expect(ctx.editMessageText).not.toHaveBeenCalled();
    });

    it("leaves the card alone and says so when the undo failed", async () => {
        const ctx = fakeCtx(undo(), ACCEPTED_CARD);

        await undoAcceptanceCallback(ctx, deps({ undoAcceptance: vi.fn().mockResolvedValue("failed") }));

        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Не вийшло. Спробуй ще раз.");
        expect(ctx.editMessageText).not.toHaveBeenCalled();
    });
});

describe("ownerRevertCallback", () => {
    beforeEach(() => vi.clearAllMocks());

    it("reverts, answers in English and syncs the bot's copy at once", async () => {
        const ctx = fakeCtx("ignored");
        const d = deps();

        await ownerRevertCallback(ctx, "req-1", false, d);

        expect(d.revertAsOwner).toHaveBeenCalledWith({
            telegramId: 5415140023,
            requestPublicId: "req-1",
            acknowledgeLateRevert: false,
        });
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Reverted. The search goes on.");
        expect(d.syncCanonicalRequest).toHaveBeenCalledWith(ctx.api, "req-1");
    });

    it("does not touch anything for someone who is not the owner", async () => {
        const ctx = fakeCtx("ignored");
        const d = deps({ revertAsOwner: vi.fn().mockResolvedValue("denied") });

        await ownerRevertCallback(ctx, "req-1", false, d);

        expect(d.syncCanonicalRequest).not.toHaveBeenCalled();
        expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
    });

    it("asks for a second, distinct tap when the shift starts within two hours", async () => {
        const ctx = fakeCtx("ignored");
        const d = deps({ revertAsOwner: vi.fn().mockResolvedValue("needs_acknowledgement") });

        await ownerRevertCallback(ctx, "req-1", false, d);

        const markup = (ctx.editMessageReplyMarkup.mock.calls[0]![0] as { reply_markup: unknown }).reply_markup;
        const buttons = buttonsOf(markup);
        expect(buttons.map((button) => button.text)).toEqual(["↩️ Revert anyway", "Keep it"]);
        expect(buttons[0]!.callback_data).toMatch(/^cb:replrvc:req-1:/u);
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ show_alert: true }));
        expect(d.syncCanonicalRequest).not.toHaveBeenCalled();
    });

    it("keeps the revert answered even when the local sync fails", async () => {
        const ctx = fakeCtx("ignored");
        const d = deps({ syncCanonicalRequest: vi.fn().mockRejectedValue(new Error("backend down")) });

        await expect(ownerRevertCallback(ctx, "req-1", true, d)).resolves.toBeUndefined();

        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Reverted. The search goes on.");
        expect(d.logWarn).toHaveBeenCalled();
    });

    it("tells the owner to use the admin panel when the backend refused", async () => {
        const ctx = fakeCtx("ignored");

        await ownerRevertCallback(ctx, "req-1", false, deps({ revertAsOwner: vi.fn().mockResolvedValue("failed") }));

        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Didn't work. Try the admin panel.");
    });
});

describe("buildAcceptedOfferKeyboard", () => {
    it("signs the undo button for exactly this offer", () => {
        const [button] = buttonsOf(buildAcceptedOfferKeyboard("offer-42"));
        expect(button!.callback_data).toMatch(/^cb:replun:offer-42:[a-f0-9]+$/u);
    });
});
