import { Composer, InlineKeyboard } from "grammy";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import logger from "../core/logger.js";
import { AwsBusinessApiError, awsBusinessClient, type ShootTaskRefusalCode } from "../services/aws-business-client.js";
import {
    SHOOT_DUE_BACK_CODE,
    SHOOT_DUE_CONFIRM_CODE,
    SHOOT_DUE_DATE_CODE,
    SHOOT_DUE_PICK_CODE,
    SHOOT_SUPPORT_CODE,
    renderShootTask,
    supportKeyboard,
} from "../services/shoot-task-render.js";
import type { MyContext } from "../types/context.js";
import { dayLabel, fromYymmdd, toYymmdd } from "../utils/shoot-format.js";
import { buildSignedCallback, readSignedCallback } from "../utils/signed-callback.js";

/**
 * Кнопки нагадувань фотографу про зйомки (план 4): sdp → дати, sdd → підтвердження,
 * sdc → перенос, sdb → назад, sds → підтримка. Payload — `ref` рядка outbox або
 * `ref.YYMMDD` (спек «Кнопки: 64 байта»). Хто натиснула — лише `callbackQuery.from.id`:
 * сервер звіряє його з фотографом зйомки, з payload чи тексту він не береться.
 * У логи — лише назва помилки й код відмови: ні тексту повідомлення, ні телефону.
 */

const REF = /^[a-z2-7]{12}$/u;
const REF_DATE = /^([a-z2-7]{12})\.(\d{6})$/u;
const NO_PREVIEW = { is_disabled: true } as const;

/**
 * Telegram чекає відповіді на натискання ~15 с, а клієнт вебаппа — до 20 с. Якщо вебапп
 * мовчить довше, спливашка «Спробуй ще раз» іде вчасно, а пізній результат однаково
 * перемальовує повідомлення.
 */
export const ANSWER_DEADLINE_MS = 8_000;

export function parseRef(payload: string | null): string | null {
    return payload !== null && REF.test(payload) ? payload : null;
}

export function parseRefDate(payload: string | null): { ref: string; date: string } | null {
    const m = payload === null ? null : REF_DATE.exec(payload);
    const date = m ? fromYymmdd(m[2]!) : null;
    return m && date ? { ref: m[1]!, date } : null;
}

/** По три дати в ряд (сім у ряд на телефоні обрізали б «пт 17.10»), вихідні не ховаються; «Назад» — окремим рядом. */
export function dueKeyboard(ref: string, options: readonly string[]): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    options.forEach((date, index) => {
        keyboard.text(dayLabel(date), buildSignedCallback(SHOOT_DUE_DATE_CODE, `${ref}.${toYymmdd(date)}`));
        if (index % 3 === 2) keyboard.row();
    });
    if (options.length % 3 !== 0) keyboard.row();
    return keyboard.text(STAFF_TEXTS["shoot-task-btn-back"], buildSignedCallback(SHOOT_DUE_BACK_CODE, ref));
}

export function confirmKeyboard(ref: string, date: string): InlineKeyboard {
    return new InlineKeyboard()
        .text(STAFF_TEXTS["shoot-task-btn-confirm"], buildSignedCallback(SHOOT_DUE_CONFIRM_CODE, `${ref}.${toYymmdd(date)}`))
        .row()
        .text(STAFF_TEXTS["shoot-task-btn-back"], buildSignedCallback(SHOOT_DUE_BACK_CODE, ref));
}

const TOASTS: Record<ShootTaskRefusalCode, keyof typeof STAFF_TEXTS> = {
    SHOOT_TASK_NOT_FOUND: "shoot-task-ans-not-yours",
    SHOOT_CANCELLED: "shoot-task-ans-cancelled",
    SHOOT_PHOTOS_RECEIVED: "shoot-task-ans-received",
    SHOOT_DUE_ALREADY_MOVED: "shoot-task-ans-moved",
    SHOOT_DUE_OUT_OF_RANGE: "shoot-task-ans-out-of-range",
};

function refusalCode(outcome: unknown): string | undefined {
    if (outcome instanceof AwsBusinessApiError) return outcome.code;
    if (typeof outcome === "object" && outcome !== null && (outcome as { ok?: unknown }).ok === false) {
        const code = (outcome as { code?: unknown }).code;
        return typeof code === "string" ? code : undefined;
    }
    return undefined;
}

/** Відмова (`{ok:false, code}`) — коротка відповідь зі спеку; мережа, 5xx і решта — «Спробуй ще раз». */
export function toastFor(outcome: unknown): string {
    const code = refusalCode(outcome);
    const key = code !== undefined && Object.hasOwn(TOASTS, code) ? TOASTS[code as ShootTaskRefusalCode] : undefined;
    return STAFF_TEXTS[key ?? "shoot-task-ans-retry"] as string;
}

/**
 * Відмови, після яких екран вибору дати — глухий кут: «Назад» знову отримає ту саму відмову.
 * На них у пікера лишається тільки «Написати в підтримку» — куди й веде спливашка.
 * «Не твоя» (вона ж «контур вимкнено») повідомлення не чіпає.
 */
const PICKER_DEAD_END = new Set<ShootTaskRefusalCode>([
    "SHOOT_CANCELLED",
    "SHOOT_PHOTOS_RECEIVED",
    "SHOOT_DUE_ALREADY_MOVED",
    "SHOOT_DUE_OUT_OF_RANGE",
]);

/** Перенос відбувся, а повідомлення не перемалювалось — дата хоча б у спливашці. */
export function movedToast(dueOn: string): string {
    return STAFF_TEXTS["shoot-task-ans-moved-to"]({ due: dayLabel(dueOn) });
}

type Client = Pick<typeof awsBusinessClient, "shootTaskDueOptions" | "moveShootTaskDue" | "shootTaskSupportLine">;
export type ShootTaskHandlerDeps = {
    client: Client;
    openSupport(ctx: MyContext, shootLine: string): Promise<void>;
};

const defaultDeps: ShootTaskHandlerDeps = {
    client: awsBusinessClient,
    async openSupport(ctx, shootLine) {
        // Динамічно, як menus/staff.ts: модуль меню тягне за собою пів бота.
        const { startSupportFlow } = await import("../modules/staff/handlers/menu.js");
        await startSupportFlow(ctx, { shootLine });
    },
};

const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

const isNotModified = (error: unknown): boolean =>
    error instanceof Error && /message is not modified/iu.test(error.message);

type Answer = (text?: string) => Promise<void>;

/**
 * Рівно одна відповідь на натискання. `answerCallbackQuery` контексту підмінено на час обробки:
 * startSupportFlow відповідає сам (і тоді друга відповідь не йде), а якщо не відповів ніхто —
 * порожня відповідь у finally. Таймер дедлайну відповідає «Спробуй ще раз», якщо вебапп мовчить.
 */
async function handleOnce(
    ctx: MyContext,
    operation: string,
    work: (answer: Answer) => Promise<void>,
    deadlineToast: string = STAFF_TEXTS["shoot-task-ans-retry"],
): Promise<void> {
    const original = ctx.answerCallbackQuery;
    let answered = false;
    const guarded = (async (...args: Parameters<MyContext["answerCallbackQuery"]>) => {
        if (answered) return true;
        answered = true;
        try {
            return await original.apply(ctx, args);
        } catch (error: unknown) {
            logger.warn({ operation, errorName: errorName(error) }, "Shoot task callback answer failed");
            return false;
        }
    }) as MyContext["answerCallbackQuery"];
    ctx.answerCallbackQuery = guarded;
    const answer: Answer = async (text) => {
        await (text === undefined ? guarded() : guarded(text));
    };
    const deadline = setTimeout(() => void answer(deadlineToast), ANSWER_DEADLINE_MS);
    try {
        await work(answer);
    } catch (error: unknown) {
        logger.warn({ operation, errorName: errorName(error) }, "Shoot task button failed");
        await answer(toastFor(error));
    } finally {
        clearTimeout(deadline);
        if (!answered) await answer();
        ctx.answerCallbackQuery = original;
    }
}

/**
 * Правка після успіху вебаппа: її збій не причина казати «Спробуй ще раз» — дія вже відбулась.
 * `false` — повідомлення лишилось старим («not modified» — це успіх: воно вже таке).
 */
async function edit(operation: string, run: () => Promise<unknown>): Promise<boolean> {
    try {
        await run();
        return true;
    } catch (error: unknown) {
        if (isNotModified(error)) return true;
        logger.warn({ operation, errorName: errorName(error) }, "Shoot task message edit failed");
        return false;
    }
}

export function createShootTaskHandlers(deps: ShootTaskHandlerDeps = defaultDeps) {
    const payloadOf = (ctx: MyContext, code: string): string | null => readSignedCallback(ctx.callbackQuery?.data ?? "", code);
    const telegramIdOf = (ctx: MyContext): number | null => ctx.callbackQuery?.from?.id ?? null;
    const expired = (answer: Answer) => answer(STAFF_TEXTS["schedule-notif-ans-expired"]);
    const refused = async (answer: Answer, operation: string, code: ShootTaskRefusalCode) => {
        logger.info({ operation, code }, "Shoot task button refused");
        await answer(toastFor({ ok: false, code }));
    };

    return {
        pick: (ctx: MyContext) =>
            handleOnce(ctx, "shoot_task.pick", async (answer) => {
                const ref = parseRef(payloadOf(ctx, SHOOT_DUE_PICK_CODE));
                const telegramId = telegramIdOf(ctx);
                if (ref === null || telegramId === null) return expired(answer);
                const result = await deps.client.shootTaskDueOptions(ref, telegramId);
                if (!result.ok) return refused(answer, "shoot_task.pick", result.code);
                if (result.options.length === 0) return refused(answer, "shoot_task.pick", "SHOOT_DUE_OUT_OF_RANGE");
                await edit("shoot_task.pick", () =>
                    ctx.editMessageText(STAFF_TEXTS["shoot-task-pick-due"]({ current: dayLabel(result.currentDueOn) }), {
                        parse_mode: "HTML",
                        reply_markup: dueKeyboard(ref, result.options),
                    }),
                );
                await answer();
            }),

        /** Спроба одна — промах пальцем коштував би її цілком, тому підтвердження (HIG). Вебапп не питаємо. */
        date: (ctx: MyContext) =>
            handleOnce(ctx, "shoot_task.date", async (answer) => {
                const parsed = parseRefDate(payloadOf(ctx, SHOOT_DUE_DATE_CODE));
                if (parsed === null) return expired(answer);
                await edit("shoot_task.date", () =>
                    ctx.editMessageText(STAFF_TEXTS["shoot-task-confirm-due"]({ due: dayLabel(parsed.date) }), {
                        parse_mode: "HTML",
                        reply_markup: confirmKeyboard(parsed.ref, parsed.date),
                    }),
                );
                await answer();
            }),

        /** Вебапп мовчить довше за спливашку — «Переношу»: пізній результат однаково перемалює повідомлення. */
        confirm: (ctx: MyContext) =>
            handleOnce(
                ctx,
                "shoot_task.confirm",
                async (answer) => {
                    const parsed = parseRefDate(payloadOf(ctx, SHOOT_DUE_CONFIRM_CODE));
                    const telegramId = telegramIdOf(ctx);
                    if (parsed === null || telegramId === null) return expired(answer);
                    const result = await deps.client.moveShootTaskDue(parsed.ref, telegramId, parsed.date);
                    if (!result.ok) return refused(answer, "shoot_task.confirm", result.code);
                    const { text } = renderShootTask({ ...result.item, dueOn: result.dueOn }, { moved: true });
                    const shown = await edit("shoot_task.confirm", () =>
                        ctx.editMessageText(text, {
                            parse_mode: "HTML",
                            link_preview_options: NO_PREVIEW,
                            reply_markup: supportKeyboard(parsed.ref),
                        }),
                    );
                    await (shown ? answer() : answer(movedToast(result.dueOn)));
                },
                STAFF_TEXTS["shoot-task-ans-moving"],
            ),

        /** Повідомлення — точно як було: текст і кнопки з живого `item`, той самий рендер, що й при відправці. */
        back: (ctx: MyContext) =>
            handleOnce(ctx, "shoot_task.back", async (answer) => {
                const ref = parseRef(payloadOf(ctx, SHOOT_DUE_BACK_CODE));
                const telegramId = telegramIdOf(ctx);
                if (ref === null || telegramId === null) return expired(answer);
                const result = await deps.client.shootTaskDueOptions(ref, telegramId);
                if (!result.ok) {
                    if (PICKER_DEAD_END.has(result.code)) {
                        await edit("shoot_task.back", () => ctx.editMessageReplyMarkup({ reply_markup: supportKeyboard(ref) }));
                    }
                    return refused(answer, "shoot_task.back", result.code);
                }
                const { text, keyboard } = renderShootTask(result.item);
                await edit("shoot_task.back", () =>
                    ctx.editMessageText(text, {
                        parse_mode: "HTML",
                        link_preview_options: NO_PREVIEW,
                        reply_markup: keyboard ?? { inline_keyboard: [] },
                    }),
                );
                await answer();
            }),

        /** Рядок про зйомку — лише через startSupportFlow; сесію тут не чіпаємо. */
        support: (ctx: MyContext) =>
            handleOnce(ctx, "shoot_task.support", async (answer) => {
                const ref = parseRef(payloadOf(ctx, SHOOT_SUPPORT_CODE));
                const telegramId = telegramIdOf(ctx);
                if (ref === null || telegramId === null) return expired(answer);
                const result = await deps.client.shootTaskSupportLine(ref, telegramId);
                if (!result.ok) return refused(answer, "shoot_task.support", result.code);
                await deps.openSupport(ctx, result.line);
            }),
    };
}

export const shootTaskHandlers = new Composer<MyContext>();
const handlers = createShootTaskHandlers();
shootTaskHandlers.callbackQuery(new RegExp(`^cb:${SHOOT_DUE_PICK_CODE}:`), (ctx) => handlers.pick(ctx));
shootTaskHandlers.callbackQuery(new RegExp(`^cb:${SHOOT_DUE_DATE_CODE}:`), (ctx) => handlers.date(ctx));
shootTaskHandlers.callbackQuery(new RegExp(`^cb:${SHOOT_DUE_CONFIRM_CODE}:`), (ctx) => handlers.confirm(ctx));
shootTaskHandlers.callbackQuery(new RegExp(`^cb:${SHOOT_DUE_BACK_CODE}:`), (ctx) => handlers.back(ctx));
shootTaskHandlers.callbackQuery(new RegExp(`^cb:${SHOOT_SUPPORT_CODE}:`), (ctx) => handlers.support(ctx));
