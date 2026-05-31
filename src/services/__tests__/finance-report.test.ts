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
        findAllActive: vi.fn().mockResolvedValue([
            {
                id: "loc-leoland",
                name: "Leolend",
                city: "Львів",
                fopId: "KUZNETSOV",
                hasAcquiring: false,
                cashInEnvelope: false
            }
        ])
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
    getReportableTerminalAmount: vi.fn((amount: number) => amount),
    shouldExcludeTerminalFromFopAccounting: vi.fn(() => false)
}));

vi.mock("../../core/queue.js", () => ({
    reportsQueue: {
        add: vi.fn()
    }
}));

import { calculateCashSalaryDeduction, syncToDDS } from "../finance-report.js";

describe("finance report DDS sync", () => {
    it("deducts photographer salary per staff member from cash", async () => {
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
