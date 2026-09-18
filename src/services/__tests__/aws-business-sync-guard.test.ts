import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
    AWS_BUSINESS_SYNC_INTERVAL_MS: 300_000,
}));

const loggerMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
vi.mock("../../core/logger.js", () => ({ default: loggerMock }));
const logBusinessEventMock = vi.fn();
vi.mock("../../core/log-events.js", () => ({
    logBusinessEvent: logBusinessEventMock,
    logSecurityEvent: vi.fn(),
}));

const awsBusinessClientMock = {
    snapshot: vi.fn(),
    reportTelegramLinks: vi.fn(),
};
vi.mock("../aws-business-client.js", () => ({ awsBusinessClient: awsBusinessClientMock }));

function transactionStub() {
    return {
        location: {
            findFirst: vi.fn().mockResolvedValue(null),
            update: vi.fn(),
            create: vi.fn().mockResolvedValue({ id: "location-1" }),
            findMany: vi.fn().mockResolvedValue([]),
        },
        locationOpeningHours: {
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            createMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        user: { upsert: vi.fn().mockResolvedValue({ id: "user-1" }) },
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
    user: { findMany: vi.fn().mockResolvedValue([]) },
    systemState: {
        upsert: vi.fn().mockResolvedValue(undefined),
        findUnique: vi.fn().mockResolvedValue(null),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn((callback: (tx: ReturnType<typeof transactionStub>) => unknown) =>
        callback(transactionStub())),
};
vi.mock("../../db/core.js", () => ({ default: prismaMock }));

/**
 * A snapshot carrying `locationCount` locations and `employeeCount` employees.
 * Both collections are otherwise inert: the guard only ever reads their length.
 */
function snapshot(locationCount: number, employeeCount: number) {
    return {
        schemaVersion: 1 as const,
        generatedAt: "2026-09-18T12:00:00.000Z",
        completeEmployeeSnapshot: true as const,
        completeLocationSnapshot: true as const,
        scheduleWindow: { from: "2026-09-01", to: "2026-09-30" },
        locations: Array.from({ length: locationCount }, (_, index) => ({
            publicId: `22222222-2222-4222-8222-2222222222${String(index).padStart(2, "0")}`,
            canonicalCode: `location-${index}`,
            name: `Location ${index}`,
            city: "Kyiv",
            isActive: true,
            openingHours: [],
        })),
        employees: Array.from({ length: employeeCount }, (_, index) => ({
            publicId: `11111111-1111-4111-8111-1111111111${String(index).padStart(2, "0")}`,
            telegramId: String(486213975 + index),
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

/** Stores what a previous successful pass would have written to `systemState`. */
function previousPass(locations: number, employees: number) {
    return {
        key: "aws-business-sync:last",
        value: JSON.stringify({
            generatedAt: "2026-09-18T11:00:00.000Z",
            locations,
            employees,
        }),
    };
}

describe("AwsBusinessSyncService — snapshot shrink guard", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        prismaMock.staffProfile.count.mockResolvedValue(0);
        prismaMock.staffProfile.findMany.mockResolvedValue([]);
        prismaMock.user.findMany.mockResolvedValue([]);
        prismaMock.systemState.upsert.mockResolvedValue(undefined);
        prismaMock.systemState.findUnique.mockResolvedValue(null);
        prismaMock.$transaction.mockImplementation(
            (callback: (tx: ReturnType<typeof transactionStub>) => unknown) => callback(transactionStub()));
        awsBusinessClientMock.reportTelegramLinks.mockResolvedValue({ updated: 0 });
    });

    it("accepts closing a few locations", async () => {
        // The incident that motivated this guard: 19 locations became 16 because three
        // venues were closed. Legitimate business change, must not stop the sync.
        prismaMock.systemState.findUnique.mockResolvedValue(previousPass(19, 181));
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot(16, 181));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        const result = await new AwsBusinessSyncService().syncAll();

        expect(result.locations).toBe(16);
    });

    it("rejects a snapshot that loses most of its locations at once", async () => {
        // No plausible business event closes two thirds of the venues between two
        // passes five minutes apart. This is the data-loss case the guard exists for.
        prismaMock.systemState.findUnique.mockResolvedValue(previousPass(19, 181));
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot(6, 181));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await expect(new AwsBusinessSyncService().syncAll()).rejects.toThrow(/locations/i);
    });

    it("rejects a snapshot that loses most of its employees at once", async () => {
        prismaMock.systemState.findUnique.mockResolvedValue(previousPass(19, 181));
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot(19, 60));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await expect(new AwsBusinessSyncService().syncAll()).rejects.toThrow(/employees/i);
    });

    it("accepts any snapshot on the very first pass", async () => {
        // A bot starting against an empty database has nothing to compare against.
        // Refusing here would mean it could never bootstrap.
        prismaMock.systemState.findUnique.mockResolvedValue(null);
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot(16, 181));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        const result = await new AwsBusinessSyncService().syncAll();

        expect(result.locations).toBe(16);
    });

    it("rejects an empty snapshot even on the first pass", async () => {
        // Zero is never a legitimate business state, and with no previous pass to
        // compare against the ratio check alone would let it through.
        prismaMock.systemState.findUnique.mockResolvedValue(null);
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot(0, 0));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await expect(new AwsBusinessSyncService().syncAll()).rejects.toThrow();
    });

    it("accepts growth without limit", async () => {
        // Opening venues must never be treated as an anomaly.
        prismaMock.systemState.findUnique.mockResolvedValue(previousPass(16, 181));
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot(40, 400));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        const result = await new AwsBusinessSyncService().syncAll();

        expect(result.locations).toBe(40);
    });

    it("compares against the last stored pass, so repeated shrink is caught step by step", async () => {
        // Guards that compare against a hardcoded floor drift out of date as the
        // business changes. This one re-baselines on every successful pass, so the
        // question is always "what changed since last time", never "what was true
        // when someone last edited the config".
        prismaMock.systemState.findUnique.mockResolvedValue(previousPass(8, 100));
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot(7, 100));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        const result = await new AwsBusinessSyncService().syncAll();

        expect(result.locations).toBe(7);
    });

    it("logs the refusal with both counts so the cause is visible without a redeploy", async () => {
        prismaMock.systemState.findUnique.mockResolvedValue(previousPass(19, 181));
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot(6, 181));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await expect(new AwsBusinessSyncService().syncAll()).rejects.toThrow();

        expect(logBusinessEventMock).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "bot.aws_business_snapshot.rejected",
                safeContext: expect.objectContaining({ locations: 6, previousLocations: 19 }),
            }),
        );
    });
});
