import { describe, expect, it, vi, beforeEach } from "vitest";

const addTransaction = vi.fn();
const recordDdsRevenue = vi.fn();

vi.mock("../dds.js", () => ({ ddsService: { addTransaction } }));
vi.mock("../../aws-business-client.js", () => ({
    awsBusinessClient: { recordDdsRevenue },
    AwsBusinessApiError: class extends Error {
        constructor(public status: number, public code?: string) {
            super("aws error");
        }
    },
}));

const targetRef = { value: "sheets" as string };
vi.mock("../../../config.js", () => ({
    get FINANCE_DDS_TARGET() {
        return targetRef.value;
    },
}));
vi.mock("../../../core/logger.js", () => ({
    default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { writeDdsEntry, toIsoDate } = await import("../dds-writer.js");

const entry = (overrides: Record<string, unknown> = {}) => ({
    date: "15.07.2026",
    amount: 12000,
    fop: "Счёт ФОП Кузнецов",
    category: "Выручка от продаж",
    comment: "Выручка",
    location: "Volkland (Готівка)",
    locationCode: "volkland-1-baburka",
    walletCode: "fop-kuznetsov",
    articleCode: "vyruchka-ot-prodazh",
    paymentMethod: "CASH" as const,
    ...overrides,
});

describe("dds writer", () => {
    beforeEach(() => {
        addTransaction.mockReset();
        recordDdsRevenue.mockReset();
        targetRef.value = "sheets";
    });

    it("writes only to the sheet by default", async () => {
        const result = await writeDdsEntry(entry());
        expect(addTransaction).toHaveBeenCalledOnce();
        expect(recordDdsRevenue).not.toHaveBeenCalled();
        expect(result).toMatchObject({ wroteSheets: true, wroteApi: false });
    });

    it("writes only to the API when switched over", async () => {
        targetRef.value = "api";
        const result = await writeDdsEntry(entry());
        expect(addTransaction).not.toHaveBeenCalled();
        expect(recordDdsRevenue).toHaveBeenCalledOnce();
        expect(result).toMatchObject({ wroteSheets: false, wroteApi: true });
    });

    it("writes to both during the parallel week", async () => {
        // The whole point of the flag: a discrepancy shows up only on real data,
        // and until then the sheet has to stay usable.
        targetRef.value = "both";
        const result = await writeDdsEntry(entry());
        expect(addTransaction).toHaveBeenCalledOnce();
        expect(recordDdsRevenue).toHaveBeenCalledOnce();
        expect(result).toMatchObject({ wroteSheets: true, wroteApi: true });
    });

    it("converts the sheet's date format for the API", async () => {
        targetRef.value = "api";
        await writeDdsEntry(entry({ date: "05.08.2026" }));
        expect(recordDdsRevenue.mock.calls[0]![0].paidOn).toBe("2026-08-05");
    });

    it("treats a location already in the app as expected, not as a failure", async () => {
        // Its revenue now comes from the tills. Raising this as an error would
        // page the owner over a routine event.
        targetRef.value = "api";
        const { AwsBusinessApiError } = await import("../../aws-business-client.js");
        recordDdsRevenue.mockRejectedValueOnce(
            new (AwsBusinessApiError as never as new (s: number, c: string) => Error)(
                409,
                "LOCATION_ALREADY_IN_APP"
            )
        );

        const result = await writeDdsEntry(entry());
        expect(result.skippedInApp).toBe(true);
        expect(result.wroteApi).toBe(false);
    });

    it("still raises any other API failure", async () => {
        targetRef.value = "api";
        recordDdsRevenue.mockRejectedValueOnce(new Error("network down"));
        await expect(writeDdsEntry(entry())).rejects.toThrow("network down");
    });

    it("skips the API write when a canonical code is missing", async () => {
        // A location that exists only in the bot cannot be addressed in the
        // webapp. Logged rather than silently dropped.
        targetRef.value = "api";
        const result = await writeDdsEntry(entry({ locationCode: null }));
        expect(recordDdsRevenue).not.toHaveBeenCalled();
        expect(result.wroteApi).toBe(false);
    });

    describe("toIsoDate", () => {
        it("converts DD.MM.YYYY", () => {
            expect(toIsoDate("05.08.2026")).toBe("2026-08-05");
        });

        it("leaves an ISO date alone", () => {
            expect(toIsoDate("2026-08-05")).toBe("2026-08-05");
        });
    });
});
