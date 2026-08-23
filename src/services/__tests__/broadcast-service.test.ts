import { describe, expect, it, vi } from "vitest";
import { broadcastService } from "../broadcast.js";

describe("broadcastService media delivery", () => {
    it("sends mixed rich-media fallbacks as standard Telegram media", async () => {
        const api = {
            sendPhoto: vi.fn().mockResolvedValue({ message_id: 10 }),
            sendVoice: vi.fn().mockResolvedValue({ message_id: 11 }),
            sendMessage: vi.fn().mockResolvedValue({ message_id: 12 }),
        };

        await broadcastService.sendTestBroadcast(
            api,
            123,
            "<b>Reliable HTML fallback</b>",
            [
                { type: "photo", fileId: "photo-file-id" },
                { type: "voice", fileId: "voice-file-id" },
            ],
            "none",
        );

        expect(api.sendPhoto).toHaveBeenCalledWith(123, "photo-file-id");
        expect(api.sendVoice).toHaveBeenCalledWith(123, "voice-file-id");
        expect(api.sendMessage).toHaveBeenCalledWith(
            123,
            "<b>Reliable HTML fallback</b>",
            expect.objectContaining({ parse_mode: "HTML" }),
        );
    });

    it("sends animation broadcasts and follows up with formatted text/buttons", async () => {
        const api = {
            sendAnimation: vi.fn().mockResolvedValue({ message_id: 10 }),
            sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
        };

        await broadcastService.sendTestBroadcast(
            api,
            123,
            "<b>Hello</b>",
            { type: "animation", fileId: "gif-file-id" },
            "default"
        );

        expect(api.sendAnimation).toHaveBeenCalledWith(123, "gif-file-id");
        expect(api.sendMessage).toHaveBeenCalledWith(
            123,
            "<b>Hello</b>",
            expect.objectContaining({ parse_mode: "HTML", reply_markup: expect.any(Object) })
        );

        const replyMarkup = api.sendMessage.mock.calls[0]?.[2]?.reply_markup;
        expect(replyMarkup.inline_keyboard).toEqual([[{
            text: "✅ Ознайомлена",
            callback_data: "test_confirm_ok",
        }, {
            text: "❌ Не згодна",
            callback_data: "test_confirm_decline",
            style: "danger",
        }]]);
    });

    it("sends document broadcasts without buttons when requested", async () => {
        const api = {
            sendDocument: vi.fn().mockResolvedValue({ message_id: 10 }),
            sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
        };

        await broadcastService.sendTestBroadcast(
            api,
            123,
            "Plain text",
            { type: "document", fileId: "document-file-id" },
            "none"
        );

        expect(api.sendDocument).toHaveBeenCalledWith(123, "document-file-id");
        expect(api.sendMessage).toHaveBeenCalledWith(
            123,
            "Plain text",
            expect.not.objectContaining({ reply_markup: expect.anything() })
        );
    });
});

/**
 * Кнопка «🚫 Не буду заповнювати» задумывалась для увольняющихся. Эту задачу
 * теперь решает `worksUntil` на бэкенде — такой человек не попадает в `/missing`
 * и напоминаний не получает. У кнопки осталось лишь одно свойство: она была
 * коротким путём к результату, который форма даёт и так («Заповнити» → ничего
 * не выбирать → «✨ Немає побажань»), но писала DECLINED вместо SUBMITTED, из-за
 * чего счётчики владельца расходились.
 */
describe("preferences broadcast keyboard", () => {
    async function preferencesKeyboard() {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };
        await broadcastService.sendTestBroadcast(api, 123, "Побажання", undefined, "preferences");
        const extra = api.sendMessage.mock.calls[0]?.[2];
        return extra?.reply_markup?.inline_keyboard ?? [];
    }

    it("offers filling in the schedule", async () => {
        const rows = await preferencesKeyboard();

        expect(JSON.stringify(rows)).toContain("pref_fill");
    });

    it("no longer offers opting out of filling it in", async () => {
        const rows = await preferencesKeyboard();

        expect(JSON.stringify(rows)).not.toContain("pref_opt_out");
    });

    /** Один путь к результату, а не два: второй существовал только как ярлык. */
    it("is a single button", async () => {
        const rows = await preferencesKeyboard();

        expect(rows.flat()).toHaveLength(1);
    });
});
