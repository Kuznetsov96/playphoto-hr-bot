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

import { locationRepository } from "../../repositories/location-repository.js";
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
});

describe("daily finance report", () => {
    it("formats location labels once and sorts by actual income", async () => {
        vi.mocked(locationRepository.findAllActive).mockResolvedValue([
            {
                id: "loc-fk-kyiv",
                name: "Fly Kids (Київ)",
                city: "Київ",
            } as any,
            {
                id: "loc-sp-lviv",
                name: "Smile Park (Львів)",
                city: "Львів",
            } as any,
            {
                id: "loc-sp-troieshchyna",
                name: "Smile Park (Troieshchyna)",
                city: "Київ",
            } as any,
            {
                id: "loc-drive",
                name: "Drive City (Львів)",
                city: "Львів",
            } as any
        ]);

        vi.mocked(techCashService.getIncomeForDate).mockResolvedValue([
            {
                locationId: "loc-fk-kyiv",
                locationName: "Fly Kids (Київ)",
                city: "Київ",
                totalCash: 1600,
                totalTerminal: 1300,
                totalIncome: 2900,
                date: "10.07.2026",
            },
            {
                locationId: "loc-sp-lviv",
                locationName: "Smile Park (Львів)",
                city: "Львів",
                totalCash: 1250,
                totalTerminal: 6000,
                totalIncome: 7250,
                date: "10.07.2026",
            },
            {
                locationId: "loc-sp-troieshchyna",
                locationName: "Smile Park (Troieshchyna)",
                city: "Київ",
                totalCash: 2550,
                totalTerminal: 0,
                totalIncome: 2550,
                date: "10.07.2026",
            }
        ]);

        const sendMessage = vi.fn();
        const bot = { api: { sendMessage } } as any;

        await sendDailyIncomeReport(bot, 123);

        expect(sendMessage).toHaveBeenCalledTimes(1);
        const reportText = sendMessage.mock.calls[0]![1] as string;
        expect(reportText).toContain("📍 Smile Park (Львів): <b>7,250 грн</b>");
        expect(reportText).toContain("📍 Fly Kids (Київ): <b>2,900 грн</b>");
        expect(reportText).not.toContain("Smile Park (Львів) (Львів)");
        expect(reportText).not.toContain("Fly Kids (Київ) (Київ)");
        expect(reportText).toContain("- Drive City (Львів)\n");
        expect(reportText).toContain("💳 Terminal: 7,300 UAH");
        expect(reportText).toContain("🔥 <b>TOTAL: 12,700 UAH</b>");

        expect(reportText.indexOf("Fly Kids (Київ)")).toBeLessThan(
            reportText.indexOf("Smile Park (Troieshchyna) (Київ)")
        );
    });
});
