import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
    AWS_BUSINESS_MIN_EMPLOYEES: 0,
    AWS_BUSINESS_MIN_LOCATIONS: 0,
    AWS_BUSINESS_SYNC_INTERVAL_MS: 300_000,
}));

const loggerMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
vi.mock("../../core/logger.js", () => ({ default: loggerMock }));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn(), logSecurityEvent: vi.fn() }));

const awsBusinessClientMock = {
    snapshot: vi.fn(),
    reportTelegramLinks: vi.fn(),
};
vi.mock("../aws-business-client.js", () => ({ awsBusinessClient: awsBusinessClientMock }));

/**
 * A transaction object generous enough for both `syncEmployeesAndLocations`
 * and `syncShifts` to run against without special-casing per test: no
 * existing locations/staff/shifts, so every snapshot row is a plain create.
 */
function transactionStub() {
    return {
        location: {
            findFirst: vi.fn().mockResolvedValue(null),
            update: vi.fn(),
            create: vi.fn().mockResolvedValue({ id: "location-1" }),
            findMany: vi.fn().mockResolvedValue([]),
        },
        user: {
            upsert: vi.fn().mockResolvedValue({ id: "user-1" }),
        },
        staffProfile: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: "staff-1" }),
            update: vi.fn(),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            findMany: vi.fn().mockResolvedValue([]),
        },
        workShift: {
            findMany: vi.fn().mockResolvedValue([]),
            create: vi.fn().mockResolvedValue({ id: "shift-1" }),
            update: vi.fn(),
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
    };
}

const prismaMock = {
    staffProfile: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
    },
    user: {
        findMany: vi.fn().mockResolvedValue([]),
    },
    systemState: {
        upsert: vi.fn().mockResolvedValue(undefined),
    },
    $transaction: vi.fn((callback: (tx: ReturnType<typeof transactionStub>) => unknown) =>
        callback(transactionStub())),
};
vi.mock("../../db/core.js", () => ({ default: prismaMock }));

/** Minimal complete snapshot: no locations/shifts needed once the min guards are mocked to 0. */
function snapshot(employees: Array<{ telegramId: string }>) {
    return {
        schemaVersion: 1 as const,
        generatedAt: "2026-08-10T12:00:00.000Z",
        completeEmployeeSnapshot: true as const,
        completeLocationSnapshot: true as const,
        scheduleWindow: { from: "2026-08-01", to: "2026-08-31" },
        locations: [],
        employees: employees.map((employee, index) => ({
            publicId: `11111111-1111-4111-8111-11111111111${index}`,
            telegramId: employee.telegramId,
            fullName: "Test Employee",
            firstName: "Test",
            lastName: "Employee",
            patronymic: null,
            phone: null,
            telegramUsername: null,
            birthDate: null,
            hiredAt: null,
            status: "ACTIVE" as const,
            assignments: [],
        })),
        shifts: [],
    };
}

describe("AwsBusinessSyncService — reportTelegramLinks", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.staffProfile.count.mockResolvedValue(0);
        prismaMock.staffProfile.findMany.mockResolvedValue([]);
        prismaMock.user.findMany.mockResolvedValue([]);
        prismaMock.systemState.upsert.mockResolvedValue(undefined);
        prismaMock.$transaction.mockImplementation((callback: (tx: ReturnType<typeof transactionStub>) => unknown) =>
            callback(transactionStub()));
        awsBusinessClientMock.reportTelegramLinks.mockResolvedValue({ updated: 0 });
    });

    it("does not fail the sync when reporting telegram links fails", async () => {
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot([{ telegramId: "486213975" }]));
        awsBusinessClientMock.reportTelegramLinks.mockRejectedValue(new Error("backend unavailable"));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        const result = await new AwsBusinessSyncService().syncAll();

        expect(result.employees).toBe(1);
        expect(loggerMock.warn).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.any(Error) }),
            "could not report telegram links",
        );
    });

    it("derives found from the User table lookup and omits username when absent", async () => {
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot([
            { telegramId: "486213975" },
            { telegramId: "486213976" },
            { telegramId: "486213977" },
        ]));
        prismaMock.user.findMany.mockResolvedValue([
            { telegramId: 486213975n, username: "ivan_petrov" },
            { telegramId: 486213977n, username: null },
        ]);
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await new AwsBusinessSyncService().syncAll();

        expect(awsBusinessClientMock.reportTelegramLinks).toHaveBeenCalledWith([
            { telegramId: "486213975", found: true, username: "ivan_petrov" },
            { telegramId: "486213976", found: false },
            { telegramId: "486213977", found: true },
        ]);
    });

    it("chunks at 500 entries and the chunks reproduce the input exactly", async () => {
        const employees = Array.from({ length: 501 }, (_, index) => ({
            telegramId: String(100000000 + index),
        }));
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot(employees));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await new AwsBusinessSyncService().syncAll();

        expect(awsBusinessClientMock.reportTelegramLinks).toHaveBeenCalledTimes(2);
        const firstChunk = awsBusinessClientMock.reportTelegramLinks.mock.calls.at(0)?.[0];
        const secondChunk = awsBusinessClientMock.reportTelegramLinks.mock.calls.at(1)?.[0];
        expect(firstChunk).toHaveLength(500);
        expect(secondChunk).toHaveLength(1);
        expect([...(firstChunk ?? []), ...(secondChunk ?? [])]).toEqual(
            employees.map((employee) => ({ telegramId: employee.telegramId, found: false })),
        );
    });

    it("issues no HTTP request for an empty employee list", async () => {
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot([]));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await new AwsBusinessSyncService().syncAll();

        expect(awsBusinessClientMock.reportTelegramLinks).not.toHaveBeenCalled();
    });
});
