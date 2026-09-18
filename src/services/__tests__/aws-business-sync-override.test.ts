import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const awsBusinessClientMock = { snapshot: vi.fn(), reportTelegramLinks: vi.fn() };
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
    staffProfile: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
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

function storedValue(key: string, value: unknown) {
    return { key, value: JSON.stringify(value) };
}

/** Routes systemState reads by key, so a test can set a baseline and an override separately. */
function stateReturning(state: Record<string, unknown>) {
    return ({ where }: { where: { key: string } }) => {
        const value = state[where.key];
        return Promise.resolve(value === undefined ? null : storedValue(where.key, value));
    };
}

const BASELINE = { generatedAt: "2026-09-18T11:00:00.000Z", locations: 16, employees: 181 };

/** Clock the suite runs at. Everything below is expressed relative to it. */
const NOW = new Date("2026-09-18T12:00:00.000Z");
/** Armed a minute ago: comfortably inside the one-hour window. */
const ARMED_FRESH = new Date(NOW.getTime() - 60_000).toISOString();
/** Armed just over the window: the forgotten-override case. */
const ARMED_STALE = new Date(NOW.getTime() - 61 * 60_000).toISOString();

describe("AwsBusinessSyncService — shrink override", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        prismaMock.staffProfile.count.mockResolvedValue(0);
        prismaMock.staffProfile.findMany.mockResolvedValue([]);
        prismaMock.user.findMany.mockResolvedValue([]);
        prismaMock.systemState.upsert.mockResolvedValue(undefined);
        prismaMock.systemState.deleteMany.mockResolvedValue({ count: 0 });
        prismaMock.$transaction.mockImplementation(
            (callback: (tx: ReturnType<typeof transactionStub>) => unknown) => callback(transactionStub()));
        awsBusinessClientMock.reportTelegramLinks.mockResolvedValue({ updated: 0 });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("admits a snapshot that would otherwise be refused", async () => {
        // Closing six of sixteen venues in one go is a real thing an owner may do.
        // Without an override the only route is to close them in batches, waiting
        // for a pass between each — the guard would otherwise hold the whole day up.
        prismaMock.systemState.findUnique.mockImplementation(stateReturning({
            "aws-business-sync:last": BASELINE,
            "aws-business-sync:allow-shrink": { armedAt: ARMED_FRESH, armedBy: "107794048" },
        }));
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot(10, 181));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        const result = await new AwsBusinessSyncService().syncAll();

        expect(result.locations).toBe(10);
    });

    it("spends the override, so the pass after it is guarded again", async () => {
        // An override left armed is a guard quietly switched off. It covers the one
        // pass it was armed for and nothing else.
        prismaMock.systemState.findUnique.mockImplementation(stateReturning({
            "aws-business-sync:last": BASELINE,
            "aws-business-sync:allow-shrink": { armedAt: ARMED_FRESH, armedBy: "107794048" },
        }));
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot(10, 181));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await new AwsBusinessSyncService().syncAll();

        expect(prismaMock.systemState.deleteMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { key: "aws-business-sync:allow-shrink" } }),
        );
    });

    it("does not spend the override on a pass that needed no help", async () => {
        // Arming ahead of a planned closure must survive the ordinary passes that
        // happen in between, or the operator has to time it to the minute.
        prismaMock.systemState.findUnique.mockImplementation(stateReturning({
            "aws-business-sync:last": BASELINE,
            "aws-business-sync:allow-shrink": { armedAt: ARMED_FRESH, armedBy: "107794048" },
        }));
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot(16, 181));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await new AwsBusinessSyncService().syncAll();

        expect(prismaMock.systemState.deleteMany).not.toHaveBeenCalled();
    });

    it("ignores an override older than its expiry", async () => {
        // Forgotten arming is the failure mode here: a stale override would sit
        // there for weeks and admit the one genuinely broken snapshot.
        prismaMock.systemState.findUnique.mockImplementation(stateReturning({
            "aws-business-sync:last": BASELINE,
            "aws-business-sync:allow-shrink": { armedAt: ARMED_STALE, armedBy: "107794048" },
        }));
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot(10, 181));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await expect(new AwsBusinessSyncService().syncAll()).rejects.toThrow(/locations/i);
    });

    it("never admits an empty snapshot, even with an override armed", async () => {
        // Zero rows is not a business decision anyone can sign off on: it is the
        // backend failing. The override covers shrink, not data loss.
        prismaMock.systemState.findUnique.mockImplementation(stateReturning({
            "aws-business-sync:last": BASELINE,
            "aws-business-sync:allow-shrink": { armedAt: ARMED_FRESH, armedBy: "107794048" },
        }));
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot(0, 0));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await expect(new AwsBusinessSyncService().syncAll()).rejects.toThrow(/empty/i);
    });

    it("records who armed the override that let a shrink through", async () => {
        // The audit trail is the point: a shrink that passed on someone's signature
        // must be traceable to that someone afterwards.
        prismaMock.systemState.findUnique.mockImplementation(stateReturning({
            "aws-business-sync:last": BASELINE,
            "aws-business-sync:allow-shrink": { armedAt: ARMED_FRESH, armedBy: "107794048" },
        }));
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot(10, 181));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await new AwsBusinessSyncService().syncAll();

        expect(logBusinessEventMock).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "bot.aws_business_snapshot.shrink_admitted",
                safeContext: expect.objectContaining({
                    locations: 10,
                    previousLocations: 16,
                    armedBy: "107794048",
                }),
            }),
        );
    });
});
