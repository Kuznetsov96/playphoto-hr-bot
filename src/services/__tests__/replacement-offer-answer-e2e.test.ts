import { describe, expect, it, vi } from "vitest";

/**
 * Сквозная проверка кнопок под сообщением об офферe — от HTTP-ответа бэкенда до
 * исхода, по которому бот выбирает текст фотографу.
 *
 * За десять суток до фикса: приём — 5 успешных и 3 честных отказа
 * REPLACEMENT_OFFER_CLOSED; отказ — 173 из 173 провалов, из них 140
 * OFFER_ANSWER_FAILED. То есть «Не можу» не работала вообще никогда, а «Можу
 * вийти» работала всегда. Юнит-тесты клиента этого не ловили, потому что
 * проверяли разбор ответа, а не то, что увидит фотограф.
 */

vi.mock("../../config.js", () => ({
    AWS_BUSINESS_API_URL: "https://example.test/api/v1/internal/bot",
    AWS_BUSINESS_API_TOKEN: "x".repeat(32),
}));

const { awsBusinessClient } = await import("../aws-business-client.js");
const { answerReplacementOffer } = await import("../replacement-notification-dispatcher.js");

describe("сквозная проверка: что увидит фотограф, нажав «Не можу»", () => {
    it("отказ доходит до конца и возвращает declined, а не failed", async () => {
        // Ровно то, что отвечает прод: ReplacementDeclineResponseDto = { status }
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true, status: 200, json: async () => ({ status: "DECLINED" }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const outcome = await answerReplacementOffer({
            offerPublicId: "d69fd0ab-f4aa-4d82-8859-1208844c4f17",
            employeePublicId: "44444444-4444-4444-8444-444444444444",
            telegramId: 1368744350,
            answer: "decline",
            client: awsBusinessClient,
        });

        // "failed" -> «Не вдалося зберегти відповідь». "declined" -> «Дякуємо за відповідь».
        expect(outcome).toBe("declined");
        vi.unstubAllGlobals();
    });

    it("закрытый оффер остаётся понятным «gone», а не ложной ошибкой", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false, status: 409,
            json: async () => ({ code: "REPLACEMENT_OFFER_CLOSED", message: "closed" }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const outcome = await answerReplacementOffer({
            offerPublicId: "d69fd0ab-f4aa-4d82-8859-1208844c4f17",
            employeePublicId: "44444444-4444-4444-8444-444444444444",
            telegramId: 1368744350,
            answer: "decline",
            client: awsBusinessClient,
        });

        expect(outcome).toBe("gone");
        vi.unstubAllGlobals();
    });

    it("приём по-прежнему разбирает полный запрос и возвращает accepted", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true, status: 200,
            json: async () => ({
                publicId: "840cd169-0000-4000-8000-000000000003",
                status: "CONFIRMED", nextWaveAt: null,
            }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const outcome = await answerReplacementOffer({
            offerPublicId: "77c30fb6-0000-4000-8000-000000000001",
            employeePublicId: "44444444-4444-4444-8444-444444444444",
            telegramId: 1368744350,
            answer: "accept",
            client: awsBusinessClient,
        });

        expect(outcome).toBe("accepted");
        vi.unstubAllGlobals();
    });
});

/**
 * Что происходит при повторном нажатии.
 *
 * Кнопки снимаются с сообщения сразу после успешного ответа
 * (`editMessageReplyMarkup` с пустой клавиатурой), но это делается «как получится»:
 * вызов обёрнут в `.catch`, и у Telegram есть свои причины отказать — сообщение
 * старше 48 часов, сеть моргнула, гонка двух нажатий подряд. Поэтому нельзя
 * считать, что снятая клавиатура — единственная защита.
 *
 * Вторая защита — бэкенд: и приём, и отказ выходят рано на уже выставленном
 * статусе, ничего не меняя. Здесь проверяется, что этот ранний выход доходит до
 * фотографа осмысленным текстом, а не ошибкой.
 */
describe("повторное нажатие тієї самої кнопки", () => {
    const offer = "d69fd0ab-f4aa-4d82-8859-1208844c4f17";
    const employee = "44444444-4444-4444-8444-444444444444";

    it("другий «Не можу» знову каже «дякуємо», а не показує помилку", async () => {
        // Бэкенд на уже отклонённом оффере отвечает тем же подтверждением.
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true, status: 200, json: async () => ({ status: "DECLINED" }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const first = await answerReplacementOffer({
            offerPublicId: offer, employeePublicId: employee,
            telegramId: 1368744350, answer: "decline", client: awsBusinessClient,
        });
        const second = await answerReplacementOffer({
            offerPublicId: offer, employeePublicId: employee,
            telegramId: 1368744350, answer: "decline", client: awsBusinessClient,
        });

        expect(first).toBe("declined");
        expect(second).toBe("declined");
        vi.unstubAllGlobals();
    });

    it("другий «Можу вийти» не створює другої зміни", async () => {
        // `acceptOffer` выходит рано на offer.status === 'ACCEPTED' и возвращает
        // тот же запрос — никакого второго reassignShift.
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true, status: 200,
            json: async () => ({
                publicId: "840cd169-0000-4000-8000-000000000003",
                status: "CONFIRMED", nextWaveAt: null,
            }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const second = await answerReplacementOffer({
            offerPublicId: offer, employeePublicId: employee,
            telegramId: 1368744350, answer: "accept", client: awsBusinessClient,
        });

        expect(second).toBe("accepted");
        vi.unstubAllGlobals();
    });

    /**
     * Передумала после отказа: жмёт «Можу вийти» на том же сообщении. Бэкенд
     * отвечает 409 REPLACEMENT_OFFER_CLOSED — оффер уже не OFFERED. Фотографе
     * это показывается как «Зміну вже закрито», а не как сбой.
     */
    it("«Можу вийти» після відмови чесно каже, що зміну закрито", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false, status: 409,
            json: async () => ({ code: "REPLACEMENT_OFFER_CLOSED", message: "closed" }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const outcome = await answerReplacementOffer({
            offerPublicId: offer, employeePublicId: employee,
            telegramId: 1368744350, answer: "accept", client: awsBusinessClient,
        });

        expect(outcome).toBe("gone");
        vi.unstubAllGlobals();
    });
});
