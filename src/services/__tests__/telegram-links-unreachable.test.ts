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

describe("telegram link reporting", () => {
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

    /**
     * A person who blocked the bot must be reported as unreachable, not omitted. Omission is
     * indistinguishable from "not checked" on the API side, which is why the signal was lost.
     * Having blocked the bot, they still have a `User` row from before — the naive "row exists"
     * check would say `found: true`, which is the exact bug this test guards against.
     */
    it("reports a blocked person as not found", async () => {
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot([{ telegramId: "486213975" }]));
        prismaMock.user.findMany.mockResolvedValue([
            { telegramId: 486213975n, username: "ivan_petrov", botBlockedAt: new Date("2026-08-23T00:00:00.000Z") },
        ]);
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await new AwsBusinessSyncService().syncAll();

        expect(awsBusinessClientMock.reportTelegramLinks).toHaveBeenCalledWith([
            { telegramId: "486213975", found: false, username: "ivan_petrov" },
        ]);
    });

    it("reports a reachable person as found", async () => {
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot([{ telegramId: "486213975" }]));
        prismaMock.user.findMany.mockResolvedValue([
            { telegramId: 486213975n, username: "ivan_petrov", botBlockedAt: null },
        ]);
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await new AwsBusinessSyncService().syncAll();

        expect(awsBusinessClientMock.reportTelegramLinks).toHaveBeenCalledWith([
            { telegramId: "486213975", found: true, username: "ivan_petrov" },
        ]);
    });

    /**
     * A brand-new hire who has never opened the chat has no `User` row at all — that is
     * "not checked yet", not "unreachable". The API has no third state: every id in the
     * `links` payload is bucketed as either verified or unreachable (and unreachable puts
     * a Deactivate button in front of the owner). So an unknown id must never be sent with
     * any `found` value — it must be left out of the payload entirely. This is the
     * regression test for the bug where `found: user?.reachable ?? false` collapsed
     * "never messaged the bot" into "blocked the bot".
     */
    it("omits a person with no User row instead of guessing found", async () => {
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot([
            { telegramId: "486213975" },
            { telegramId: "486213999" },
        ]));
        prismaMock.user.findMany.mockResolvedValue([
            { telegramId: 486213975n, username: "ivan_petrov", botBlockedAt: null },
            // 486213999 has no row: never interacted with the bot.
        ]);
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await new AwsBusinessSyncService().syncAll();

        const [payload] = awsBusinessClientMock.reportTelegramLinks.mock.calls[0] as [
            Array<{ telegramId: string; found: boolean }>,
        ];
        expect(payload.find((link) => link.telegramId === "486213999")).toBeUndefined();
        expect(payload).toEqual([{ telegramId: "486213975", found: true, username: "ivan_petrov" }]);
    });
});
