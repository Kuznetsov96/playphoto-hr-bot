import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/callback-secret.js", () => ({ CALLBACK_SECRET: "test-secret" }));

const { AwsBusinessApiError } = await import("../../services/aws-business-client.js");
const { buildSignedCallback } = await import("../../utils/signed-callback.js");
const { createShootTaskHandlers, dueKeyboard, confirmKeyboard, parseRef, parseRefDate, toastFor, movedToast, ANSWER_DEADLINE_MS } =
    await import("../shoot-tasks.js");
const { supportKeyboard, renderShootTask } = await import("../../services/shoot-task-render.js");
import type { AwsShootTask } from "../../services/aws-business-client.js";

const REF = "abcdefgh2345";
const item: AwsShootTask = {
    publicId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    ref: REF,
    kind: "OVERDUE",
    telegramId: "77",
    shoot: {
        clientName: "Олена",
        childName: null,
        phone: null,
        notes: null,
        location: { name: "Dragon Park 1", city: "Lviv", branch: null },
        shootOn: "2030-03-12",
        intervals: [{ start: "15:00", end: "16:00" }],
        durationMinutes: 60,
    },
    dueOn: "2030-03-15",
    canMoveDue: true,
    overdueDays: 1,
    returnComment: null,
    pathB: false,
    targetMessageId: null,
};

type Keyboard = { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> };

/** Натискання від Telegram: `from` — лише в callbackQuery, `ctx.from` навмисно чужий. */
function ctx(data: string, fromId = 77) {
    return {
        from: { id: 999 },
        callbackQuery: { data, from: { id: fromId } },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        editMessageText: vi.fn().mockResolvedValue(true),
        editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    };
}

function deps() {
    return {
        client: {
            shootTaskDueOptions: vi.fn().mockResolvedValue({
                ok: true,
                currentDueOn: "2030-03-15",
                options: ["2030-03-17", "2030-03-18", "2030-03-19", "2030-03-20"],
                item,
            }),
            moveShootTaskDue: vi.fn().mockResolvedValue({
                ok: true,
                dueOn: "2030-03-18",
                item: { ...item, dueOn: "2030-03-18", canMoveDue: false },
            }),
            shootTaskSupportLine: vi.fn().mockResolvedValue({ ok: true, line: "Зйомка · Олена · Dragon Park 1, Lviv" }),
        },
        openSupport: vi.fn().mockResolvedValue(undefined),
    };
}

const labels = (options: unknown) => (options as { reply_markup: Keyboard }).reply_markup.inline_keyboard.flat().map((b) => b.text);

afterEach(() => {
    vi.useRealTimers();
});

describe("shoot task buttons: keyboards and payloads", () => {
    it("every callback fits Telegram's 64 bytes with the worst payload", () => {
        const worst = "z".repeat(12);
        const all = [
            ...dueKeyboard(worst, ["2099-12-31", "2099-12-30", "2099-12-29", "2099-12-28"]).inline_keyboard.flat(),
            ...confirmKeyboard(worst, "2099-12-31").inline_keyboard.flat(),
            ...supportKeyboard(worst).inline_keyboard.flat(),
            ...(renderShootTask({ ...item, ref: worst, kind: "PHOTOS_DUE" }).keyboard?.inline_keyboard.flat() ?? []),
            { callback_data: buildSignedCallback("sdp", worst) },
        ];
        expect(all.length).toBeGreaterThan(8);
        for (const button of all) {
            const data = (button as { callback_data: string }).callback_data;
            expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
        }
    });

    it("lays dates three per row and ends with «Назад» on its own row", () => {
        const rows = dueKeyboard(REF, ["2030-03-17", "2030-03-18", "2030-03-19", "2030-03-20"]).inline_keyboard;
        expect(rows.map((r) => r.map((b) => b.text))).toEqual([["нд 17.03", "пн 18.03", "вт 19.03"], ["ср 20.03"], ["Назад"]]);
        const full = dueKeyboard(REF, ["2030-03-17", "2030-03-18", "2030-03-19"]).inline_keyboard;
        expect(full.map((r) => r.map((b) => b.text))).toEqual([["нд 17.03", "пн 18.03", "вт 19.03"], ["Назад"]]);
    });

    it("confirmation offers «Так, перенести» and «Назад»", () => {
        const rows = confirmKeyboard(REF, "2030-03-18").inline_keyboard;
        expect(rows.map((r) => r.map((b) => b.text))).toEqual([["Так, перенести"], ["Назад"]]);
    });

    it("refuses a forged or impossible payload", () => {
        expect(parseRefDate(`${REF}.300230`)).toBeNull();
        expect(parseRefDate("ABC.300317")).toBeNull();
        expect(parseRefDate(null)).toBeNull();
        expect(parseRefDate(`${REF}.300317`)).toEqual({ ref: REF, date: "2030-03-17" });
        expect(parseRef(REF)).toBe(REF);
        expect(parseRef(`${REF}.300317`)).toBeNull();
        expect(parseRef("ABCDEFGH2345")).toBeNull();
    });

    it("maps every refusal code to its toast; anything else asks to retry", () => {
        const refusal = (code: string) => toastFor({ ok: false, code });
        expect(refusal("SHOOT_TASK_NOT_FOUND")).toBe("Ця зйомка вже не твоя.");
        expect(refusal("SHOOT_CANCELLED")).toBe("Зйомку скасовано.");
        expect(refusal("SHOOT_PHOTOS_RECEIVED")).toBe("Фото вже на перевірці.");
        expect(refusal("SHOOT_DUE_ALREADY_MOVED")).toBe("Термін уже перенесено — напиши в підтримку.");
        expect(refusal("SHOOT_DUE_OUT_OF_RANGE")).toBe("Дата вже недоступна — обери іншу.");
        expect(toastFor(new AwsBusinessApiError(502, undefined, "x"))).toBe("Спробуй ще раз за хвилину.");
        expect(toastFor(new TypeError("fetch failed"))).toBe("Спробуй ще раз за хвилину.");
    });
});

describe("shoot task buttons: handlers", () => {
    it("pick → dates screen in the same message, telegramId from the callback", async () => {
        const d = deps();
        const c = ctx(buildSignedCallback("sdp", REF));
        await createShootTaskHandlers(d as never).pick(c as never);
        expect(d.client.shootTaskDueOptions).toHaveBeenCalledWith(REF, 77);
        const [text, options] = c.editMessageText.mock.calls[0]!;
        expect(text).toBe("Зараз термін — пт 15.03. Обери новий.\nПеренести можна один раз — далі лише через адміністратора.");
        expect(labels(options)).toEqual(["нд 17.03", "пн 18.03", "вт 19.03", "ср 20.03", "Назад"]);
        expect(c.answerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    it("date → confirmation, without calling the webapp", async () => {
        const d = deps();
        const c = ctx(buildSignedCallback("sdd", `${REF}.300318`));
        await createShootTaskHandlers(d as never).date(c as never);
        const [text, options] = c.editMessageText.mock.calls[0]!;
        expect(text).toBe("Новий термін — пн 18.03?\nПісля цього змінити його зможе лише адміністратор.");
        expect(labels(options)).toEqual(["Так, перенести", "Назад"]);
        expect(d.client.moveShootTaskDue).not.toHaveBeenCalled();
        expect(d.client.shootTaskDueOptions).not.toHaveBeenCalled();
        expect(c.answerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    const waiting = (pathB: boolean) =>
        "Чекаємо фото зі зйомки.\n\nЗйомка · Олена\n📍 Dragon Park 1 (Lviv)\n📅 вт 12.03, 15:00–16:00\n\n" +
        "Новий термін — пн 18.03 включно. Нагадаю зранку в цей день.\nУ касі точки натисни «Надіслати фото» — можна зі своєї зміни або зі зміни колеги." +
        (pathB ? "\nЯкщо зміни немає — на екрані PIN-коду натисни «Надіслати фото ДН»." : "");
    const returned =
        "Фото повернули на доопрацювання.\n\nЗйомка · Олена\n📍 Dragon Park 1 (Lviv)\n📅 вт 12.03, 15:00–16:00\n\nЩо виправити:\n<blockquote>Темно</blockquote>\n\n" +
        "Новий термін — пн 18.03 включно. Виправ і надішли знову з каси. Нагадаю зранку в цей день.\nЯкщо зміни немає — на екрані PIN-коду натисни «Надіслати фото ДН».";

    it.each([
        ["OVERDUE", { kind: "OVERDUE", overdueDays: 1, pathB: false }, waiting(false)],
        ["DUE_TODAY", { kind: "DUE_TODAY", overdueDays: null, pathB: true }, waiting(true)],
        ["PHOTOS_DUE", { kind: "PHOTOS_DUE", overdueDays: null, pathB: false }, waiting(false)],
        ["RETURNED", { kind: "RETURNED", overdueDays: null, pathB: true, returnComment: "Темно" }, returned],
    ] as const)("confirm on %s → moved state with exactly one date, support only", async (_kind, patch, expected) => {
        const d = deps();
        d.client.moveShootTaskDue.mockResolvedValue({
            ok: true,
            dueOn: "2030-03-18",
            item: { ...item, ...patch, dueOn: "2030-03-18", canMoveDue: false },
        });
        const c = ctx(buildSignedCallback("sdc", `${REF}.300318`));
        await createShootTaskHandlers(d as never).confirm(c as never);
        expect(d.client.moveShootTaskDue).toHaveBeenCalledWith(REF, 77, "2030-03-18");
        const [text, options] = c.editMessageText.mock.calls[0]!;
        expect(text).toBe(expected);
        expect(text.split("Новий термін").length - 1).toBe(1);
        expect(text).not.toContain("Термін — ");
        expect(text).not.toContain("Термін минув");
        expect(text).not.toContain("призначає адміністратор");
        expect(text).not.toContain("Сьогодні останній день");
        expect(labels(options)).toEqual(["Написати в підтримку"]);
        expect(c.answerCallbackQuery).toHaveBeenCalledTimes(1);
        expect(c.answerCallbackQuery).toHaveBeenCalledWith();
    });

    it.each([
        ["SHOOT_TASK_NOT_FOUND", "Ця зйомка вже не твоя."],
        ["SHOOT_CANCELLED", "Зйомку скасовано."],
        ["SHOOT_PHOTOS_RECEIVED", "Фото вже на перевірці."],
        ["SHOOT_DUE_ALREADY_MOVED", "Термін уже перенесено — напиши в підтримку."],
        ["SHOOT_DUE_OUT_OF_RANGE", "Дата вже недоступна — обери іншу."],
    ])("confirm refused with %s → popup, message unchanged", async (code, toast) => {
        const d = deps();
        d.client.moveShootTaskDue.mockResolvedValue({ ok: false, code });
        const c = ctx(buildSignedCallback("sdc", `${REF}.300318`));
        await createShootTaskHandlers(d as never).confirm(c as never);
        expect(c.answerCallbackQuery).toHaveBeenCalledTimes(1);
        expect(c.answerCallbackQuery).toHaveBeenCalledWith(toast);
        expect(c.editMessageText).not.toHaveBeenCalled();
        expect(c.editMessageReplyMarkup).not.toHaveBeenCalled();
    });

    it.each([
        ["network", new TypeError("fetch failed")],
        ["5xx", new AwsBusinessApiError(503, undefined, "AWS business API returned 503")],
    ])("pick on a %s failure → retry popup, message unchanged", async (_label, error) => {
        const d = deps();
        d.client.shootTaskDueOptions.mockRejectedValue(error);
        const c = ctx(buildSignedCallback("sdp", REF));
        await createShootTaskHandlers(d as never).pick(c as never);
        expect(c.answerCallbackQuery).toHaveBeenCalledTimes(1);
        expect(c.answerCallbackQuery).toHaveBeenCalledWith("Спробуй ще раз за хвилину.");
        expect(c.editMessageText).not.toHaveBeenCalled();
    });

    it.each(["SHOOT_DUE_OUT_OF_RANGE", "SHOOT_DUE_ALREADY_MOVED", "SHOOT_CANCELLED", "SHOOT_PHOTOS_RECEIVED"] as const)(
        "pick refused with %s → popup, text kept, only support button left",
        async (code) => {
            const d = deps();
            d.client.shootTaskDueOptions.mockResolvedValue({ ok: false, code });
            const c = ctx(buildSignedCallback("sdp", REF));
            await createShootTaskHandlers(d as never).pick(c as never);
            expect(c.answerCallbackQuery).toHaveBeenCalledTimes(1);
            expect(c.editMessageText).not.toHaveBeenCalled();
            const [markup] = c.editMessageReplyMarkup.mock.calls[0]!;
            expect((markup as { reply_markup: Keyboard }).reply_markup.inline_keyboard.flat().map((b) => b.text)).toEqual([
                "Написати в підтримку",
            ]);
        },
    );

    it("pick refused as not hers → popup only, message unchanged", async () => {
        const d = deps();
        d.client.shootTaskDueOptions.mockResolvedValue({ ok: false, code: "SHOOT_TASK_NOT_FOUND" });
        const c = ctx(buildSignedCallback("sdp", REF));
        await createShootTaskHandlers(d as never).pick(c as never);
        expect(c.answerCallbackQuery).toHaveBeenCalledWith("Ця зйомка вже не твоя.");
        expect(c.editMessageText).not.toHaveBeenCalled();
        expect(c.editMessageReplyMarkup).not.toHaveBeenCalled();
    });

    it("confirm on a network failure → retry popup once, message unchanged", async () => {
        const d = deps();
        d.client.moveShootTaskDue.mockRejectedValue(new TypeError("fetch failed"));
        const c = ctx(buildSignedCallback("sdc", `${REF}.300318`));
        await createShootTaskHandlers(d as never).confirm(c as never);
        expect(c.answerCallbackQuery).toHaveBeenCalledTimes(1);
        expect(c.answerCallbackQuery).toHaveBeenCalledWith("Спробуй ще раз за хвилину.");
        expect(c.editMessageText).not.toHaveBeenCalled();
    });

    it("a failed edit after a successful move answers with the new date, not a retry", async () => {
        const d = deps();
        const c = ctx(buildSignedCallback("sdc", `${REF}.300318`));
        c.editMessageText.mockRejectedValue(new Error("Bad Request: message can't be edited"));
        await createShootTaskHandlers(d as never).confirm(c as never);
        expect(c.answerCallbackQuery).toHaveBeenCalledTimes(1);
        expect(c.answerCallbackQuery).toHaveBeenCalledWith("Новий термін — пн 18.03.");
    });

    it("«message is not modified» after a move is a quiet success", async () => {
        const d = deps();
        const c = ctx(buildSignedCallback("sdc", `${REF}.300318`));
        c.editMessageText.mockRejectedValue(new Error("Bad Request: message is not modified"));
        await createShootTaskHandlers(d as never).confirm(c as never);
        expect(c.answerCallbackQuery).toHaveBeenCalledTimes(1);
        expect(c.answerCallbackQuery).toHaveBeenCalledWith();
    });

    it("the edit-failed popup fits 45 characters for every date", () => {
        for (const date of ["2099-12-31", "2030-03-18", "2031-01-01"]) {
            expect(movedToast(date).length).toBeLessThanOrEqual(45);
        }
    });

    it("back → the original OVERDUE message, exactly as rendered from item", async () => {
        const d = deps();
        const c = ctx(buildSignedCallback("sdb", REF));
        await createShootTaskHandlers(d as never).back(c as never);
        expect(d.client.shootTaskDueOptions).toHaveBeenCalledWith(REF, 77);
        const expected = renderShootTask(item);
        const [text, options] = c.editMessageText.mock.calls[0]!;
        expect(text).toBe(expected.text);
        expect(text).toContain("Термін минув 1 день тому");
        expect(labels(options)).toEqual(["Обрати інший термін", "Написати в підтримку"]);
        expect(c.answerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    it("back refused → popup, the picker loses its dead buttons but keeps support", async () => {
        const d = deps();
        d.client.shootTaskDueOptions.mockResolvedValue({ ok: false, code: "SHOOT_DUE_ALREADY_MOVED" });
        const c = ctx(buildSignedCallback("sdb", REF));
        await createShootTaskHandlers(d as never).back(c as never);
        expect(c.answerCallbackQuery).toHaveBeenCalledWith("Термін уже перенесено — напиши в підтримку.");
        expect(c.editMessageText).not.toHaveBeenCalled();
        const [markup] = c.editMessageReplyMarkup.mock.calls[0]!;
        expect((markup as { reply_markup: Keyboard }).reply_markup.inline_keyboard.flat().map((b) => b.text)).toEqual([
            "Написати в підтримку",
        ]);
    });

    it("back refused as not hers → popup only, message unchanged", async () => {
        const d = deps();
        d.client.shootTaskDueOptions.mockResolvedValue({ ok: false, code: "SHOOT_TASK_NOT_FOUND" });
        const c = ctx(buildSignedCallback("sdb", REF));
        await createShootTaskHandlers(d as never).back(c as never);
        expect(c.answerCallbackQuery).toHaveBeenCalledWith("Ця зйомка вже не твоя.");
        expect(c.editMessageText).not.toHaveBeenCalled();
        expect(c.editMessageReplyMarkup).not.toHaveBeenCalled();
    });

    it("back on a network failure → retry popup, message unchanged", async () => {
        const d = deps();
        d.client.shootTaskDueOptions.mockRejectedValue(new TypeError("fetch failed"));
        const c = ctx(buildSignedCallback("sdb", REF));
        await createShootTaskHandlers(d as never).back(c as never);
        expect(c.answerCallbackQuery).toHaveBeenCalledWith("Спробуй ще раз за хвилину.");
        expect(c.editMessageText).not.toHaveBeenCalled();
        expect(c.editMessageReplyMarkup).not.toHaveBeenCalled();
    });

    it("support → opens support with the shoot line only", async () => {
        const d = deps();
        const c = ctx(buildSignedCallback("sds", REF));
        await createShootTaskHandlers(d as never).support(c as never);
        expect(d.client.shootTaskSupportLine).toHaveBeenCalledWith(REF, 77);
        expect(d.openSupport).toHaveBeenCalledWith(c, "Зйомка · Олена · Dragon Park 1, Lviv");
        expect(c).not.toHaveProperty("session");
    });

    it("support: the flow answers the callback itself → no second answer", async () => {
        const d = deps();
        d.openSupport.mockImplementation(async (inner: { answerCallbackQuery: (t?: string) => Promise<unknown> }) => {
            await inner.answerCallbackQuery("Звернення вже в роботі");
        });
        const c = ctx(buildSignedCallback("sds", REF));
        await createShootTaskHandlers(d as never).support(c as never);
        expect(c.answerCallbackQuery).toHaveBeenCalledTimes(1);
        expect(c.answerCallbackQuery).toHaveBeenCalledWith("Звернення вже в роботі");
    });

    it("support: the flow returns without answering → answered once anyway", async () => {
        const d = deps();
        const c = ctx(buildSignedCallback("sds", REF));
        await createShootTaskHandlers(d as never).support(c as never);
        expect(c.answerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    it("support refused → popup, support does not open", async () => {
        const d = deps();
        d.client.shootTaskSupportLine.mockResolvedValue({ ok: false, code: "SHOOT_TASK_NOT_FOUND" });
        const c = ctx(buildSignedCallback("sds", REF));
        await createShootTaskHandlers(d as never).support(c as never);
        expect(d.openSupport).not.toHaveBeenCalled();
        expect(c.answerCallbackQuery).toHaveBeenCalledTimes(1);
        expect(c.answerCallbackQuery).toHaveBeenCalledWith("Ця зйомка вже не твоя.");
    });

    it("support on a 5xx → retry popup, support does not open", async () => {
        const d = deps();
        d.client.shootTaskSupportLine.mockRejectedValue(new AwsBusinessApiError(500, undefined, "x"));
        const c = ctx(buildSignedCallback("sds", REF));
        await createShootTaskHandlers(d as never).support(c as never);
        expect(d.openSupport).not.toHaveBeenCalled();
        expect(c.answerCallbackQuery).toHaveBeenCalledWith("Спробуй ще раз за хвилину.");
    });

    it("ignores a callback signed for another code and still answers it", async () => {
        const d = deps();
        const c = ctx(buildSignedCallback("osoa", REF));
        await createShootTaskHandlers(d as never).pick(c as never);
        expect(d.client.shootTaskDueOptions).not.toHaveBeenCalled();
        expect(c.answerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    it("ignores a tampered signature", async () => {
        const d = deps();
        const good = buildSignedCallback("sdc", `${REF}.300318`);
        const c = ctx(good.replace(".300318", ".300319"));
        await createShootTaskHandlers(d as never).confirm(c as never);
        expect(d.client.moveShootTaskDue).not.toHaveBeenCalled();
        expect(c.answerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    it("confirm: a slow webapp gets «Переношу» in time, and the late result is shown", async () => {
        vi.useFakeTimers();
        const d = deps();
        let resolve!: (value: unknown) => void;
        d.client.moveShootTaskDue.mockReturnValue(new Promise((r) => (resolve = r)));
        const c = ctx(buildSignedCallback("sdc", `${REF}.300318`));
        const spy = c.answerCallbackQuery; // під час обробки метод контексту підмінено охоронцем
        const run = createShootTaskHandlers(d as never).confirm(c as never);
        await vi.advanceTimersByTimeAsync(ANSWER_DEADLINE_MS - 1);
        expect(spy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith("Переношу — повідомлення оновиться.");
        resolve({ ok: true, dueOn: "2030-03-18", item: { ...item, dueOn: "2030-03-18", canMoveDue: false } });
        await run;
        expect(c.answerCallbackQuery).toHaveBeenCalledTimes(1);
        expect(c.editMessageText.mock.calls[0]![0]).toContain("Новий термін — пн 18.03 включно. Нагадаю зранку в цей день.");
        expect(ANSWER_DEADLINE_MS).toBeLessThan(15_000);
    });

    it.each(["pick", "back", "support"] as const)("%s: a slow webapp gets «Спробуй ще раз» in time", async (name) => {
        vi.useFakeTimers();
        const d = deps();
        const never = new Promise(() => {});
        d.client.shootTaskDueOptions.mockReturnValue(never);
        d.client.shootTaskSupportLine.mockReturnValue(never);
        const code = { pick: "sdp", back: "sdb", support: "sds" }[name];
        const c = ctx(buildSignedCallback(code, REF));
        const spy = c.answerCallbackQuery;
        void createShootTaskHandlers(d as never)[name](c as never);
        await vi.advanceTimersByTimeAsync(ANSWER_DEADLINE_MS);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith("Спробуй ще раз за хвилину.");
    });
    it("a failing answerCallbackQuery does not crash the handler", async () => {
        const d = deps();
        const c = ctx(buildSignedCallback("sdd", `${REF}.300318`));
        c.answerCallbackQuery.mockRejectedValue(new Error("query is too old"));
        await expect(createShootTaskHandlers(d as never).date(c as never)).resolves.toBeUndefined();
    });
});
