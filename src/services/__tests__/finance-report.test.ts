import { describe, expect, it, vi } from "vitest";

vi.mock("../finance/tech-cash.js", () => ({
    techCashService: {
        getIncomeForDate: vi.fn()
    }
}));

vi.mock("../finance/dds.js", () => ({
    ddsService: {
        addTransaction: vi.fn(),
        getTransactionsForDates: vi.fn(),
        matchTransaction: vi.fn()
    }
}));

vi.mock("../../config.js", () => ({
    FINANCE_IDS: [],
    FOP_DISPLAY_NAMES: {
        KUZNETSOV: "Счёт ФОП Кузнецов"
    }
}));

vi.mock("../../repositories/location-repository.js", () => ({
    locationRepository: {
        findAllActive: vi.fn()
    }
}));

vi.mock("../finance/monobank.js", () => ({
    monobankService: {}
}));

vi.mock("../../core/logger.js", () => ({
    default: {
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn()
    }
}));

vi.mock("../../core/log-events.js", () => ({
    logBusinessEvent: vi.fn()
}));

vi.mock("../finance/location-rules.js", () => ({
    getReportableCashAmount: vi.fn((amount: number, loc?: { name?: string } | null) =>
        loc?.name === "Fly Kids (Київ)" ? Number((amount * 0.7).toFixed(2)) : amount
    ),
    getReportableTerminalAmount: vi.fn((amount: number, loc?: { name?: string } | null) =>
        loc?.name === "Fly Kids (Київ)" ? 0 : amount
    ),
    shouldExcludeTerminalFromFopAccounting: vi.fn(() => false)
}));

vi.mock("../../core/queue.js", () => ({
    reportsQueue: {
        add: vi.fn()
    }
}));

vi.mock("../aws-business-client.js", () => ({
    awsBusinessClient: {
        dailySummary: vi.fn()
    }
}));

import { locationRepository } from "../../repositories/location-repository.js";
import { awsBusinessClient } from "../aws-business-client.js";
import { ddsService } from "../finance/dds.js";
import { techCashService } from "../finance/tech-cash.js";
import { calculateCashSalaryDeduction, sendDailyIncomeReport, syncToDDS } from "../finance-report.js";

describe("finance report DDS sync", () => {
    it("deducts photographer salary per staff member from cash", async () => {
        vi.mocked(locationRepository.findAllActive).mockResolvedValue([
            {
                id: "loc-leoland",
                name: "Leolend",
                city: "Львів",
                fopId: "KUZNETSOV",
                hasAcquiring: false,
                cashInEnvelope: false
            } as any
        ]);

        const result = await syncToDDS("30.05.2026", [
            {
                locationId: "loc-leoland",
                locationName: "Leolend",
                city: "Львів",
                totalCash: 11400,
                totalTerminal: 0,
                totalSalary: 3850,
                totalIncome: 11400,
                date: "30.05.2026",
                photographers: ["Photographer One", "Photographer Two"]
            }
        ], true);

        expect(result.success).toBe(true);
        expect(result.message).toContain("Add Cash: 3700");
        expect(result.message).not.toContain("Add Cash: 7550");
    });

    it("keeps legacy single-person deduction when no photographer names are available", () => {
        expect(calculateCashSalaryDeduction({ totalSalary: 3850 })).toBe(3850);
    });

    it("deducts salary from 70 percent of cash for Fly Kids Kyiv", async () => {
        vi.mocked(locationRepository.findAllActive).mockResolvedValue([
            {
                id: "loc-fk-kyiv",
                name: "Fly Kids (Київ)",
                city: "Київ",
                fopId: "KUZNETSOV",
                hasAcquiring: false,
                cashInEnvelope: false
            } as any
        ]);

        const result = await syncToDDS("14.07.2026", [
            {
                locationId: "loc-fk-kyiv",
                locationName: "Fly Kids (Київ)",
                city: "Київ",
                totalCash: 1000,
                totalTerminal: 0,
                totalSalary: 250,
                totalIncome: 1000,
                date: "14.07.2026",
                photographers: ["Photographer One"]
            }
        ], true);

        expect(result.success).toBe(true);
        expect(result.message).toContain("Add Cash: 450");
        expect(result.message).not.toContain("Add Cash: 750");
    });
});

describe("daily finance report", () => {
    it("renders the summary the webapp returned and does not feed it to the DDS sync", async () => {
        vi.mocked(awsBusinessClient.dailySummary).mockResolvedValue({
            totals: { salesTotal: 12700, cashTotal: 5400, terminalTotal: 7300 },
            locations: [
                {
                    publicId: "loc-sp-lviv",
                    label: "Smile Park, Львів",
                    salesTotal: 7250,
                    cashTotal: 1250,
                    terminalTotal: 6000
                },
                {
                    publicId: "loc-fk-kyiv",
                    label: "Fly Kids, Київ",
                    salesTotal: 2900,
                    cashTotal: 1600,
                    terminalTotal: 1300
                }
            ],
            overdue: [{ publicId: "loc-a", label: "Fly Kids, Рівне", openedAt: "2026-07-10T07:15:00.000Z" }],
            neverOpened: [{ publicId: "loc-b", label: "Volkland (Shevchyk), Запоріжжя" }]
        });

        const sendMessage = vi.fn();
        const bot = { api: { sendMessage } } as any;

        await sendDailyIncomeReport(bot, 123);

        expect(sendMessage).toHaveBeenCalledTimes(1);
        const reportText = sendMessage.mock.calls[0]![1] as string;
        expect(reportText).toContain("Smile Park, Львів");
        expect(reportText).toContain("Still open (1)");
        expect(reportText).toContain("Never opened (1)");

        // Выручка приложения уже проведена при закрытии смены: сводка не должна
        // попасть в ДДС вторым приходом.
        expect(vi.mocked(techCashService.getIncomeForDate)).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ locations: expect.anything() })
        );
        expect(vi.mocked(ddsService.addTransaction)).not.toHaveBeenCalled();
    });

    it("still sends a message when the webapp summary cannot be fetched", async () => {
        vi.mocked(awsBusinessClient.dailySummary).mockRejectedValue(new Error("upstream down"));

        const sendMessage = vi.fn();
        const bot = { api: { sendMessage } } as any;

        await sendDailyIncomeReport(bot, 123);

        // Тишина в 21:40 читается как «день пустой», а не как «отчёт сломался».
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0]![1] as string).toContain("could not be loaded");
    });
});
