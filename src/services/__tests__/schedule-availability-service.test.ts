import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    spreadsheetsGet: vi.fn(),
    valuesGet: vi.fn(),
    findAllWithStaff: vi.fn(),
    loggerWarn: vi.fn(),
}));

vi.mock("fs", () => ({
    default: { existsSync: vi.fn(() => true) },
}));

vi.mock("googleapis", () => ({
    google: {
        auth: { GoogleAuth: vi.fn() },
        sheets: vi.fn(() => ({
            spreadsheets: {
                get: mocks.spreadsheetsGet,
                values: { get: mocks.valuesGet },
            },
        })),
    },
}));

vi.mock("../../config.js", () => ({
    SPREADSHEET_ID_SCHEDULE: "schedule-sheet",
    SPREADSHEET_ID_TEAM: "team-sheet",
}));

vi.mock("../../repositories/user-repository.js", () => ({
    userRepository: {
        findAllWithStaff: mocks.findAllWithStaff,
    },
}));

vi.mock("../../core/logger.js", () => ({
    default: {
        warn: mocks.loggerWarn,
    },
}));

describe("ScheduleAvailabilityService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.valuesGet.mockResolvedValue({
            data: {
                values: [
                    [
                        "",
                        "",
                        "",
                        "",
                        "Doe John",
                        "працює",
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        "123456789",
                    ],
                ],
            },
        });
        mocks.findAllWithStaff.mockResolvedValue([
            { telegramId: 123456789n, staffProfile: { id: "staff-1" } },
        ]);
    });

    it("uses an existing month-only sheet before falling back to the current schedule", async () => {
        mocks.spreadsheetsGet.mockImplementation(async (args: any) => {
            if (args.fields === "sheets(properties(title))") {
                return {
                    data: {
                        sheets: [
                            { properties: { title: "Червень" } },
                            { properties: { title: "Актуальний розклад" } },
                        ],
                    },
                };
            }
            if (String(args.fields).includes("rowMetadata")) {
                return { data: { sheets: [{ data: [{ rowMetadata: [], columnMetadata: [] }] }] } };
            }
            return {
                data: {
                    sheets: [{
                        data: [{
                            rowData: [
                                { values: [{ formattedValue: "" }, { formattedValue: "30.06" }] },
                                { values: [] },
                                { values: [{ formattedValue: "Doe John" }, {}] },
                            ],
                        }],
                    }],
                },
            };
        });

        const { ScheduleAvailabilityService } = await import("../schedule-availability-service.js");
        const availability = await new ScheduleAvailabilityService().getAvailabilityForDateFromSchedule(new Date("2026-06-30T00:00:00.000Z"));

        expect(availability.get("staff-1")).toBe("available");
        expect(mocks.spreadsheetsGet).toHaveBeenCalledWith(expect.objectContaining({
            ranges: ["'Червень'!A1:AL500"],
        }));
        expect(mocks.spreadsheetsGet).not.toHaveBeenCalledWith(expect.objectContaining({
            ranges: ["'Червень 2026'!A1:AL500"],
        }));
        expect(mocks.loggerWarn).not.toHaveBeenCalledWith(
            expect.anything(),
            "Monthly schedule availability lookup failed"
        );
    });
});
