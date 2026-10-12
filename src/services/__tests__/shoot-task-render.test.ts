import { describe, expect, it, vi } from "vitest";

vi.mock("../../config/callback-secret.js", () => ({ CALLBACK_SECRET: "test-secret" }));

const { renderShootTask, SHOOT_DUE_PICK_CODE, SHOOT_SUPPORT_CODE, SHOOT_OFFER_TAKE_CODE, SHOOT_OFFER_DECLINE_CODE, SHOOT_OFFER_UNDO_CODE } =
    await import("../shoot-task-render.js");
const { readSignedCallback } = await import("../../utils/signed-callback.js");
const { formatLocation } = await import("../../utils/location-label.js");
import type { AwsShootTask } from "../aws-business-client.js";

const base: AwsShootTask = {
    publicId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    ref: "abcdefgh2345",
    kind: "PHOTOS_DUE",
    telegramId: "1164289764",
    shoot: {
        clientName: "Олена <script>", childName: null, phone: null, notes: null,
        location: { name: "Dragon Park 1", city: "Lviv", branch: null },
        shootOn: "2030-03-16", intervals: [{ start: "15:00", end: "16:00" }], durationMinutes: 60,
    },
    dueOn: "2030-03-19", canMoveDue: true, overdueDays: null, returnComment: null, pathB: false, targetMessageId: null,
};
const labels = (kb: ReturnType<typeof renderShootTask>["keyboard"]) => kb?.inline_keyboard.flat().map((b) => b.text) ?? [];
const callbacks = (kb: ReturnType<typeof renderShootTask>["keyboard"]) =>
    kb?.inline_keyboard.flat().map((b) => ("callback_data" in b ? b.callback_data : "")) ?? [];

describe("renderShootTask", () => {
    it("PHOTOS_DUE: block, escaped client, deadline, both buttons", () => {
        const { text, keyboard } = renderShootTask(base);
        expect(text).toBe(
            "Чекаємо фото зі зйомки.\n\nЗйомка · Олена &lt;script&gt;\n📍 Dragon Park 1 (Lviv)\n📅 сб 16.03, 15:00–16:00\n\nТермін — вт 19.03 включно.\nУ касі точки натисни «Надіслати фото» — можна зі своєї зміни або зі зміни колеги.",
        );
        expect(labels(keyboard)).toEqual(["Обрати інший термін", "Написати в підтримку"]);
    });

    it("buttons carry the outbox ref under their signed codes", () => {
        const [move, support] = callbacks(renderShootTask(base).keyboard);
        expect(readSignedCallback(move!, SHOOT_DUE_PICK_CODE)).toBe(base.ref);
        expect(readSignedCallback(support!, SHOOT_SUPPORT_CODE)).toBe(base.ref);
    });

    it("adds the path B line only when the webapp says so", () => {
        expect(renderShootTask({ ...base, pathB: true }).text.endsWith("на екрані PIN-коду натисни «Надіслати фото ДН».")).toBe(true);
        expect(renderShootTask(base).text).not.toContain("PIN-коду");
    });

    it("OVERDUE without a move left: no move button and the admin sentence", () => {
        const { text, keyboard } = renderShootTask({ ...base, kind: "OVERDUE", overdueDays: 3, canMoveDue: false });
        expect(text.startsWith("Термін минув 3 дні тому, фото ще немає.")).toBe(true);
        expect(text).toContain("Новий термін тепер призначає адміністратор");
        expect(labels(keyboard)).toEqual(["Написати в підтримку"]);
    });

    it("ASSIGNED: phone and wishes for the assigned photographer only", () => {
        const { text } = renderShootTask({
            ...base, kind: "ASSIGNED",
            shoot: { ...base.shoot, clientName: "Олена", childName: "Марійка", phone: "+380671231301", notes: "Торт" },
        });
        expect(text).toContain("🕐 15:00–16:00 (1 год)");
        // Номер моноширинний — копіюється одним дотиком.
        expect(text).toContain("Клієнт: Олена, <code>+380671231301</code>");
        expect(text).toContain("Іменинник: Марійка");
        expect(text).toContain("Побажання:\n<blockquote>Торт</blockquote>");
        expect(text).toContain("Фото — до вт 19.03 включно.");
    });

    it("ASSIGNED without a phone and without a name", () => {
        expect(renderShootTask({ ...base, kind: "ASSIGNED", shoot: { ...base.shoot, clientName: null } }).text).toContain(
            "Клієнт: телефону ще немає — адміністратор додасть його.",
        );
    });

    it("a phone outside ASSIGNED never reaches the text", () => {
        const phone = "+380671231301";
        for (const kind of ["PHOTOS_DUE", "REDACT", "DUE_CHANGED"] as const) {
            expect(renderShootTask({ ...base, kind, targetMessageId: 777, shoot: { ...base.shoot, phone } }).text).not.toContain("380");
        }
    });

    it("REDACT: same message, phone hidden, no buttons", () => {
        const { text, keyboard } = renderShootTask({ ...base, kind: "REDACT", targetMessageId: 777, shoot: { ...base.shoot, clientName: "Олена" } });
        expect(text).toContain("Клієнт: Олена · телефон приховано.");
        expect(text).not.toContain("+380");
        expect(keyboard).toBeNull();
    });

    it("RETURNED quotes the comment and gives the new deadline", () => {
        const { text } = renderShootTask({ ...base, kind: "RETURNED", returnComment: "Прибери <дублі>" });
        expect(text).toContain("Що виправити:\n<blockquote>Прибери &lt;дублі&gt;</blockquote>");
        expect(text).toContain("Новий термін — вт 19.03 включно.");
    });

    it("free text is clipped before it is escaped", () => {
        const notes = `${"&".repeat(499)}${"<".repeat(101)}`;
        const { text } = renderShootTask({ ...base, kind: "ASSIGNED", shoot: { ...base.shoot, notes } });
        expect(text).toContain(`\nПобажання:\n<blockquote>${"&amp;".repeat(499)}…</blockquote>\n`);
    });

    it("multi-line wishes stay inside one quote", () => {
        const notes = "на 10.10 фотограф 19:00 - 20:00\nкімната Панда\nЗамовниця Ірина 0676084373";
        const { text } = renderShootTask({ ...base, kind: "ASSIGNED", shoot: { ...base.shoot, notes } });
        expect(text).toContain(`Побажання:\n<blockquote>${notes}</blockquote>`);
    });

    it("the location goes through the listing label with its branch", () => {
        const location = { name: "Volkland", city: "Запоріжжя", branch: "Шевчик" };
        const { text } = renderShootTask({ ...base, shoot: { ...base.shoot, location } });
        expect(formatLocation(location, "listing")).toContain("Шевчик");
        expect(text).toContain(`📍 ${formatLocation(location, "listing")}\n`);
    });

    it("UNASSIGNED and CANCELLED carry no buttons", () => {
        expect(renderShootTask({ ...base, kind: "UNASSIGNED" }).keyboard).toBeNull();
        expect(renderShootTask({ ...base, kind: "CANCELLED" }).text.startsWith("Зйомку скасовано")).toBe(true);
    });

    it("without a client name the block title is just «Зйомка»", () => {
        expect(renderShootTask({ ...base, shoot: { ...base.shoot, clientName: null } }).text).toContain("\n\nЗйомка\n📍");
    });

    it("moved: one date in place of the deadline line, escaped block, support only", () => {
        const { text, keyboard } = renderShootTask({ ...base, kind: "OVERDUE", overdueDays: 4, canMoveDue: false }, { moved: true });
        expect(text).toBe(
            "Чекаємо фото зі зйомки.\n\nЗйомка · Олена &lt;script&gt;\n📍 Dragon Park 1 (Lviv)\n📅 сб 16.03, 15:00–16:00\n\n" +
                "Новий термін — вт 19.03 включно. Нагадаю зранку в цей день.\nУ касі точки натисни «Надіслати фото» — можна зі своєї зміни або зі зміни колеги.",
        );
        expect(labels(keyboard)).toEqual(["Написати в підтримку"]);
    });

    it("moved RETURNED: escaped comment kept, the due line says when she will be reminded", () => {
        const { text } = renderShootTask({ ...base, kind: "RETURNED", returnComment: "a < b", canMoveDue: false }, { moved: true });
        expect(text).toContain("<blockquote>a &lt; b</blockquote>\n\nНовий термін — вт 19.03 включно. Виправ і надішли знову з каси. Нагадаю зранку в цей день.");
        expect(text.split("Новий термін").length - 1).toBe(1);
    });

    describe("offers (part C)", () => {
        const offerRef = "qrstuvwx2345";
        type Offer = Extract<AwsShootTask, { kind: "OFFER" | "OFFER_REOPENED" }>;
        const shoot: Offer["shoot"] = {
            ...base.shoot,
            clientName: null,
            phone: null,
            intervals: [{ start: "15:00", end: "16:00" }, { start: "18:00", end: "19:30" }],
            durationMinutes: 150,
        };
        const offer: Offer = { ...base, kind: "OFFER", shoot, payload: { offerRef, feeAmount: 600 } };

        it("OFFER: the spec text word for word, the fee line, two signed buttons", () => {
            const { text, keyboard } = renderShootTask(offer);
            expect(text).toBe(
                "🆕 Зйомка — можеш взяти.\n\n📍 Dragon Park 1 (Lviv)\n📅 сб 16.03\n🕐 15:00–16:00, 18:00–19:30 (2,5 год)\nОплата — 600 грн.\n\nХто перший погодиться — за тим і зйомка.",
            );
            expect(labels(keyboard)).toEqual(["✅ Беру", "🚫 Не можу"]);
            const [take, decline] = callbacks(keyboard);
            expect(take!.startsWith("cb:sha:")).toBe(true);
            expect(readSignedCallback(take!, SHOOT_OFFER_TAKE_CODE)).toBe(offerRef);
            expect(readSignedCallback(decline!, SHOOT_OFFER_DECLINE_CODE)).toBe(offerRef);
            for (const data of callbacks(keyboard)) expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
        });

        it("OFFER: no fee line without a tariff; thousands are grouped, kopecks kept", () => {
            expect(renderShootTask({ ...offer, payload: { offerRef, feeAmount: null } }).text).not.toContain("Оплата");
            expect(renderShootTask({ ...offer, payload: { offerRef, feeAmount: 1600 } }).text).toContain("\nОплата — 1 600 грн.\n");
            expect(renderShootTask({ ...offer, payload: { offerRef, feeAmount: 412.5 } }).text).toContain("\nОплата — 412,50 грн.\n");
        });

        it("OFFER: no time line when the shoot has no intervals, no duration when unknown", () => {
            const noTime = renderShootTask({ ...offer, shoot: { ...shoot, intervals: [], durationMinutes: null } }).text;
            expect(noTime).not.toContain("🕐");
            const noDuration = renderShootTask({ ...offer, shoot: { ...shoot, durationMinutes: null } }).text;
            expect(noDuration).toContain("🕐 15:00–16:00, 18:00–19:30\n");
        });

        it("OFFER and OFFER_REOPENED never carry the client, the child, the wishes or a phone", () => {
            const leaky = { ...shoot, clientName: "Олена", childName: "Марійка", notes: "Торт", phone: "+380671231301" };
            for (const kind of ["OFFER", "OFFER_REOPENED"] as const) {
                const { text } = renderShootTask({ ...offer, kind, shoot: leaky } as unknown as AwsShootTask);
                expect(text).not.toMatch(/Олена|Марійка|Торт|380/u);
            }
        });

        it("OFFER_TAKEN: «Зйомка твоя», the ASSIGNED body without its first line, the undo hint; phone in <code>", () => {
            const personal = { ...shoot, clientName: "Олена", childName: "Марійка", phone: "+380671231301", notes: "Торт" };
            const taken: AwsShootTask = { ...base, kind: "OFFER_TAKEN", shoot: personal, payload: { offerRef } };
            const assigned = renderShootTask({ ...base, kind: "ASSIGNED", shoot: personal }).text;
            const { text, keyboard } = renderShootTask(taken);
            const body = assigned.split("\n").slice(2).join("\n");
            expect(text).toBe(`✅ Зйомка твоя.\n\n${body}\n\nЯкщо натиснула помилково — скасуй протягом 15 хвилин.`);
            expect(text).toContain("Клієнт: Олена, <code>+380671231301</code>");
            expect(text).not.toContain("Тобі призначено зйомку.");
            expect(labels(keyboard)).toEqual(["Скасувати", "Написати в підтримку"]);
            const [undo, support] = callbacks(keyboard);
            expect(readSignedCallback(undo!, SHOOT_OFFER_UNDO_CODE)).toBe(offerRef);
            expect(readSignedCallback(support!, SHOOT_SUPPORT_CODE)).toBe(base.ref);
        });

        it("OFFER_CLOSED: one line per variant, no buttons", () => {
            const closed = (variant: "TAKEN" | "CLOSED"): AwsShootTask => ({
                ...base,
                kind: "OFFER_CLOSED",
                shoot,
                targetMessageId: 501,
                payload: { variant, targetMessageId: 501 },
            });
            expect(renderShootTask(closed("TAKEN"))).toEqual({ text: "Цю зйомку вже взяли: Dragon Park 1 (Lviv), сб 16.03.", keyboard: null });
            expect(renderShootTask(closed("CLOSED"))).toEqual({ text: "Пропозицію закрито: Dragon Park 1 (Lviv), сб 16.03.", keyboard: null });
        });

        it("OFFER_REOPENED: the spec text, «Беру» and «Не можу» on the same offer ref", () => {
            const { text, keyboard } = renderShootTask({ ...offer, kind: "OFFER_REOPENED" });
            expect(text).toBe(
                "Зйомка на Dragon Park 1 (Lviv) сб 16.03 знову вільна — та, що погодилась, скасувала це одразу.\nЯкщо можеш — бери.",
            );
            expect(labels(keyboard)).toEqual(["✅ Беру", "🚫 Не можу"]);
            expect(readSignedCallback(callbacks(keyboard)[0]!, SHOOT_OFFER_TAKE_CODE)).toBe(offerRef);
        });

        it("REDACT after her undo: «Скасовано», place and time only, no buttons", () => {
            const undone: AwsShootTask = {
                ...base,
                kind: "REDACT",
                targetMessageId: 501,
                shoot: { ...shoot, clientName: "Олена", childName: "Марійка", notes: "Торт", phone: null },
                payload: { reason: "UNDONE" },
            };
            const { text, keyboard } = renderShootTask(undone);
            expect(text).toBe("Скасовано, зйомка знову вільна.\n\n📍 Dragon Park 1 (Lviv)\n📅 сб 16.03\n🕐 15:00–16:00, 18:00–19:30 (2,5 год)");
            expect(text).not.toMatch(/Олена|Марійка|Торт|Клієнт|призначено/u);
            expect(keyboard).toBeNull();
        });

        it("plain REDACT is unchanged by the undo variant", () => {
            const plain = renderShootTask({ ...base, kind: "REDACT", targetMessageId: 501 }).text;
            expect(plain.startsWith("Тобі призначено зйомку.")).toBe(true);
            expect(plain).toContain("телефон приховано.");
        });

        it("escapes the location in every offer text", () => {
            const location = { name: "A&B <Park>", city: "Lviv", branch: null };
            for (const kind of ["OFFER", "OFFER_REOPENED"] as const) {
                expect(renderShootTask({ ...offer, kind, shoot: { ...shoot, location } }).text).toContain("A&amp;B &lt;Park&gt;");
            }
            const closed: AwsShootTask = { ...base, kind: "OFFER_CLOSED", shoot: { ...shoot, location }, targetMessageId: 1, payload: { variant: "CLOSED", targetMessageId: 1 } };
            expect(renderShootTask(closed).text).toContain("A&amp;B &lt;Park&gt;");
        });
    });
});
