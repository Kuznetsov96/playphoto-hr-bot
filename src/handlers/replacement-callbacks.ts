/**
 * Кнопки підміни: відповідь на оффер, скасування власної згоди, відкат
 * підміни власником.
 *
 * Винесено з handlers/index.ts, щоб кожну гілку можна було перевірити тестом:
 * той модуль тягне живого бота, і обробники в ньому не покривав жоден тест
 * (аудит 09.10.2026). Залежності передаються явно; реєстрація в index.ts бере
 * `defaultReplacementCallbackDeps`.
 */
import { InlineKeyboard } from "grammy";
import { ADMIN_TEXTS } from "../constants/admin-texts.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { logBusinessEvent } from "../core/log-events.js";
import type {
    ReplacementOfferAnswerOutcome,
    ReplacementRevertOutcome,
    ReplacementUndoOutcome,
} from "../services/replacement-notification-dispatcher.js";
import {
    REPLACEMENT_OFFER_ACCEPT_CALLBACK_CODE,
    REPLACEMENT_OFFER_DECLINE_CALLBACK_CODE,
    REPLACEMENT_REVERT_CONFIRM_CALLBACK_CODE,
} from "../services/replacement-notification-dispatcher.js";
import { buildAnsweredOfferText } from "../services/replacement-offer-answered-text.js";
import { REPLACEMENT_UNDO_CALLBACK_CODE } from "../services/schedule-notification-dispatcher.js";
import { buildSignedCallback, readCallbackPayload } from "../utils/signed-callback.js";

/** Лише те з контексту grammy, чим користуються ці обробники. */
export type ReplacementCallbackContext = {
    from?: { id: number } | undefined;
    callbackQuery?: { data?: string | undefined; message?: { text?: string | undefined } | undefined } | undefined;
    api: unknown;
    answerCallbackQuery(other?: string | { text: string; show_alert?: boolean }): Promise<unknown>;
    editMessageText(text: string, other?: Record<string, unknown>): Promise<unknown>;
    editMessageReplyMarkup(other?: Record<string, unknown>): Promise<unknown>;
};

export type ReplacementCallbackDeps = {
    /** Канонічний id співробітниці за Telegram id, або null, якщо не звʼязана. */
    findEmployeePublicId(telegramId: number): Promise<string | null>;
    answerOffer(input: {
        offerPublicId: string;
        employeePublicId: string;
        telegramId: number;
        answer: "accept" | "decline";
    }): Promise<ReplacementOfferAnswerOutcome>;
    undoAcceptance(input: {
        offerPublicId: string;
        employeePublicId: string;
        telegramId: number;
    }): Promise<ReplacementUndoOutcome>;
    /** Єдина перевірка, що натиснув власник, — усередині (ADMIN_IDS). */
    revertAsOwner(input: {
        telegramId: number | undefined;
        requestPublicId: string;
        acknowledgeLateRevert: boolean;
    }): Promise<ReplacementRevertOutcome>;
    syncCanonicalRequest(api: unknown, requestPublicId: string): Promise<void>;
    logWarn(context: Record<string, unknown>, message: string): void;
};

/**
 * Кнопка скасування живе на самій карточці «✅ Ти виходиш на цю зміну», а не на
 * окремому повідомленні графіка. Раніше прийнята отримувала два повідомлення
 * поспіль про одне й те саме, і кнопка була на другому — а для зміни далі ніж
 * за добу воно взагалі чекало публікації, і вікно в 15 хвилин минало до того,
 * як кнопка з'являлась (Dragon Park, 04.10.2026).
 */
export function buildAcceptedOfferKeyboard(offerPublicId: string): InlineKeyboard {
    return new InlineKeyboard().text(
        STAFF_TEXTS["staff-replacement-accepted-btn-undo"],
        buildSignedCallback(REPLACEMENT_UNDO_CALLBACK_CODE, offerPublicId),
    );
}

/**
 * Відповідь кандидатки на оффер. Обидві кнопки ведуть сюди; відрізняє «так» від
 * «ні» лише код, яким підписано callback.
 *
 * Результат належить бекенду: він сам перевіряє, що оффер її і ще відкритий,
 * тож тут це не повторюється.
 */
export async function answerOfferCallback(
    ctx: ReplacementCallbackContext,
    answer: "accept" | "decline",
    deps: ReplacementCallbackDeps,
): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    const code = answer === "accept" ? REPLACEMENT_OFFER_ACCEPT_CALLBACK_CODE : REPLACEMENT_OFFER_DECLINE_CALLBACK_CODE;
    const offerPublicId = readCallbackPayload(data, { code });
    if (!offerPublicId) {
        await ctx.answerCallbackQuery(STAFF_TEXTS["schedule-notif-ans-expired"]);
        return;
    }

    const telegramId = ctx.from?.id;
    const employeePublicId = telegramId === undefined ? null : await deps.findEmployeePublicId(telegramId);
    if (!employeePublicId || telegramId === undefined) {
        // Без канонічного id відповідь відправити нікуди. Мовчати не можна —
        // ззовні це виглядає як зламана кнопка, а причина видна лише в даних.
        logBusinessEvent({
            event: "bot.replacement_notifications.answer_failed",
            level: "warn",
            telegramId,
            actorType: "staff",
            actorRole: "staff",
            result: "failure",
            reasonCode: "EMPLOYEE_NOT_MAPPED",
            module: "replacement-notification-dispatcher",
            operation: "answerReplacementOffer",
            safeContext: { offerPublicId, answer },
        });
        await ctx.answerCallbackQuery({ text: STAFF_TEXTS["staff-replacement-offer-error-alert"], show_alert: true });
        return;
    }

    const outcome = await deps.answerOffer({ offerPublicId, employeePublicId, telegramId, answer });

    // show_alert: вузька плашка обрізає текст десь на 45 символах, а помилка —
    // єдиний випадок, коли їй треба щось зробити.
    if (outcome === "failed") {
        await ctx.answerCallbackQuery({ text: STAFF_TEXTS["staff-replacement-offer-error-alert"], show_alert: true });
        return;
    }

    // Карточка переписується на місці: результат читається там, де названо
    // зміну. Деталі — з тексту самого повідомлення, а не з відповіді бекенда
    // (там UTC, і 14:00 за Києвом показалось би як 11:00).
    const keyboard = outcome === "accepted" ? buildAcceptedOfferKeyboard(offerPublicId) : { inline_keyboard: [] };
    const rewritten = buildAnsweredOfferText(ctx.callbackQuery?.message?.text ?? "", outcome);
    const edited = await ctx
        .editMessageText(rewritten, { parse_mode: "HTML", reply_markup: keyboard })
        .then(() => true)
        .catch(() => false);
    if (!edited) {
        // Telegram відмовляє зі своїх причин — повідомлення старше 48 годин, гонка
        // двох натискань. Тоді хоча б міняємо кнопки: мертва не має виглядати
        // живою, а кнопка скасування мусить лишитись.
        logBusinessEvent({
            event: "bot.replacement_notifications.answer_message_not_rewritten",
            level: "warn",
            telegramId,
            actorType: "staff",
            actorRole: "staff",
            result: "failure",
            reasonCode: "MESSAGE_EDIT_REJECTED",
            module: "replacement-notification-dispatcher",
            operation: "answerReplacementOffer",
            safeContext: { offerPublicId, answer, outcome },
        });
        await ctx.editMessageReplyMarkup({ reply_markup: keyboard }).catch(() => { });
    }

    const answered =
        outcome === "accepted"
            ? STAFF_TEXTS["staff-replacement-offer-accepted"]
            : outcome === "declined"
              ? STAFF_TEXTS["staff-replacement-offer-declined"]
              : STAFF_TEXTS["staff-replacement-offer-gone"];
    await ctx.answerCallbackQuery(answered);
}

/**
 * Скасування власної згоди. Бекенд сам перевіряє, що оффер її і що вікно ще
 * відкрите, тож тут ці перевірки не дублюються.
 */
export async function undoAcceptanceCallback(
    ctx: ReplacementCallbackContext,
    deps: ReplacementCallbackDeps,
): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    const offerPublicId = readCallbackPayload(data, { code: REPLACEMENT_UNDO_CALLBACK_CODE });
    if (!offerPublicId) {
        await ctx.answerCallbackQuery(STAFF_TEXTS["schedule-notif-ans-expired"]);
        return;
    }

    const telegramId = ctx.from?.id;
    const employeePublicId = telegramId === undefined ? null : await deps.findEmployeePublicId(telegramId);
    if (!employeePublicId || telegramId === undefined) {
        await ctx.answerCallbackQuery(STAFF_TEXTS["staff-replacement-undo-ans-failed"]);
        return;
    }

    const outcome = await deps.undoAcceptance({ offerPublicId, employeePublicId, telegramId });

    // Вікно закрите назавжди: кнопка, що відповідає ледь помітним тостом,
    // виглядає зламаною — 06.10.2026 фотографиня тиснула її 14 разів. Тому
    // пояснення плашкою з «ОК», і кнопка зникає.
    if (outcome === "window_closed") {
        await ctx
            .editMessageReplyMarkup({
                reply_markup: new InlineKeyboard().text(STAFF_TEXTS["schedule-notif-btn-schedule"], "staff_hub_nav"),
            })
            .catch(() => { });
        await ctx.answerCallbackQuery({ text: STAFF_TEXTS["staff-replacement-undo-ans-window-closed"], show_alert: true });
        return;
    }
    if (outcome === "failed") {
        await ctx.answerCallbackQuery(STAFF_TEXTS["staff-replacement-undo-ans-failed"]);
        return;
    }

    // Карточка мусить перестати казати «Ти виходиш»: інакше після скасування
    // вона лишається єдиним, що фотографиня бачить про цю зміну.
    const rewritten = buildAnsweredOfferText(ctx.callbackQuery?.message?.text ?? "", "undone");
    await ctx
        .editMessageText(rewritten, { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } })
        .catch(() => ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { }));
    await ctx.answerCallbackQuery(STAFF_TEXTS["staff-replacement-undo-done"]);
}

/**
 * Відкат підміни власником (кнопка в ACCEPTED_OWNER_REVIEW).
 *
 * Бекенд не може перевірити, хто натиснув: його сервісний токен доводить лише
 * «це бот». Тому `revertAsOwner` — єдиний вартовий, і він виконується щоразу.
 * Зміна менш ніж за дві години: бекенд просить підтвердження, і власник бачить
 * попередження та другу кнопку.
 */
export async function ownerRevertCallback(
    ctx: ReplacementCallbackContext,
    requestPublicId: string,
    acknowledgeLateRevert: boolean,
    deps: ReplacementCallbackDeps,
): Promise<void> {
    const outcome = await deps.revertAsOwner({ telegramId: ctx.from?.id, requestPublicId, acknowledgeLateRevert });

    if (outcome === "denied") {
        await ctx.answerCallbackQuery(STAFF_TEXTS["admin-err-access-denied"]);
        return;
    }
    if (outcome === "needs_acknowledgement") {
        await ctx
            .editMessageReplyMarkup({
                reply_markup: new InlineKeyboard()
                    .text(
                        ADMIN_TEXTS["admin-replacement-revert-late-btn-confirm"],
                        buildSignedCallback(REPLACEMENT_REVERT_CONFIRM_CALLBACK_CODE, requestPublicId),
                    )
                    .row()
                    .text(ADMIN_TEXTS["admin-replacement-revert-late-btn-cancel"], "staff_hub_nav"),
            })
            .catch(() => { });
        await ctx.answerCallbackQuery({ text: ADMIN_TEXTS["admin-replacement-revert-late-warning"], show_alert: true });
        return;
    }
    if (outcome === "failed") {
        await ctx.answerCallbackQuery(ADMIN_TEXTS["admin-replacement-revert-failed"]);
        return;
    }

    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });
    await ctx.answerCallbackQuery(ADMIN_TEXTS["admin-replacement-revert-done"]);

    // Копія заявки в боті стоїть FOUND: без звірки «Мій графік» прийнятої ще
    // показував би зміну як свою (Dragon Park, 05–08.10.2026).
    await deps.syncCanonicalRequest(ctx.api, requestPublicId).catch((err: unknown) => {
        deps.logWarn({ err, requestPublicId }, "Local replacement copy sync after owner revert failed");
    });
}

/** Справжні залежності; модулі з мережею й базою вантажаться ліниво. */
export const defaultReplacementCallbackDeps: ReplacementCallbackDeps = {
    async findEmployeePublicId(telegramId) {
        const { default: prisma } = await import("../db/core.js");
        const staff = await prisma.staffProfile.findFirst({
            where: { user: { telegramId: BigInt(telegramId) } },
            select: { awsEmployeePublicId: true },
        });
        return staff?.awsEmployeePublicId ?? null;
    },
    async answerOffer(input) {
        const { answerReplacementOffer } = await import("../services/replacement-notification-dispatcher.js");
        const { awsBusinessClient } = await import("../services/aws-business-client.js");
        return answerReplacementOffer({ ...input, client: awsBusinessClient });
    },
    async undoAcceptance(input) {
        const { undoReplacementAcceptanceAsCandidate } = await import("../services/replacement-notification-dispatcher.js");
        const { awsBusinessClient } = await import("../services/aws-business-client.js");
        return undoReplacementAcceptanceAsCandidate({ ...input, client: awsBusinessClient });
    },
    async revertAsOwner(input) {
        const { revertReplacementIfOwner } = await import("../services/replacement-notification-dispatcher.js");
        const { awsBusinessClient } = await import("../services/aws-business-client.js");
        return revertReplacementIfOwner({ ...input, client: awsBusinessClient });
    },
    async syncCanonicalRequest(api, requestPublicId) {
        const { replacementService } = await import("../services/replacement-service.js");
        await replacementService.syncCanonicalRequest(api as never, requestPublicId);
    },
    logWarn(context, message) {
        void import("../core/logger.js").then(({ default: logger }) => logger.warn(context, message));
    },
};
