import { describe, expect, it, vi } from "vitest";

vi.mock("../../config/callback-secret.js", () => ({ CALLBACK_SECRET: "test-secret" }));

const { renderShootTask, SHOOT_DUE_PICK_CODE, SHOOT_SUPPORT_CODE } = await import("../shoot-task-render.js");
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
        expect(text).toContain("Клієнт: Олена, +380671231301");
        expect(text).toContain("Іменинник: Марійка");
        expect(text).toContain("Побажання: Торт");
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
        expect(text).toContain(`\nПобажання: ${"&amp;".repeat(499)}…\n`);
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
});
