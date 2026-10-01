import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
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
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        locationOpeningHours: {
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            createMany: vi.fn().mockResolvedValue({ count: 0 }),
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
        findUnique: vi.fn().mockResolvedValue(null),
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
        locations: [{
            publicId: "22222222-2222-4222-8222-222222222200",
            canonicalCode: "location-0",
            name: "Location 0",
            city: "Kyiv",
            isActive: true,
            openingHours: [],
        }],
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
        prismaMock.user.findMany.mockResolvedValue([
            { telegramId: 486213975n, username: null, botBlockedAt: null },
        ]);
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
            { telegramId: 486213975n, username: "ivan_petrov", botBlockedAt: null },
            { telegramId: 486213977n, username: null, botBlockedAt: null },
        ]);
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await new AwsBusinessSyncService().syncAll();

        // 486213976 has no User row at all — "not checked yet", not "unreachable" — so it must
        // be left out of the payload entirely rather than sent with any found value.
        expect(awsBusinessClientMock.reportTelegramLinks).toHaveBeenCalledWith([
            { telegramId: "486213975", found: true, username: "ivan_petrov" },
            { telegramId: "486213977", found: true },
        ]);
    });

    it("chunks at 500 entries and the chunks reproduce the input exactly", async () => {
        const employees = Array.from({ length: 501 }, (_, index) => ({
            telegramId: String(100000000 + index),
        }));
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot(employees));
        prismaMock.user.findMany.mockResolvedValue(
            employees.map((employee) => ({
                telegramId: BigInt(employee.telegramId),
                username: null,
                botBlockedAt: null,
            })),
        );
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await new AwsBusinessSyncService().syncAll();

        expect(awsBusinessClientMock.reportTelegramLinks).toHaveBeenCalledTimes(2);
        const firstChunk = awsBusinessClientMock.reportTelegramLinks.mock.calls.at(0)?.[0];
        const secondChunk = awsBusinessClientMock.reportTelegramLinks.mock.calls.at(1)?.[0];
        expect(firstChunk).toHaveLength(500);
        expect(secondChunk).toHaveLength(1);
        expect([...(firstChunk ?? []), ...(secondChunk ?? [])]).toEqual(
            employees.map((employee) => ({ telegramId: employee.telegramId, found: true })),
        );
    });

    it("issues no HTTP request when no employee has a User row to report", async () => {
        // The snapshot itself carries staff — an empty one is data loss and the
        // shrink guard rejects it before this code runs. What empties the payload
        // is every employee being unknown to the User table.
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot([{ telegramId: "486213975" }]));
        prismaMock.user.findMany.mockResolvedValue([]);
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await new AwsBusinessSyncService().syncAll();

        expect(awsBusinessClientMock.reportTelegramLinks).not.toHaveBeenCalled();
    });
});

describe("AwsBusinessSyncService — locations missing from the snapshot", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.staffProfile.count.mockResolvedValue(0);
        prismaMock.staffProfile.findMany.mockResolvedValue([]);
        prismaMock.user.findMany.mockResolvedValue([]);
        prismaMock.systemState.upsert.mockResolvedValue(undefined);
    });

    it("hides every location the complete snapshot no longer carries", async () => {
        // The web app sends only ACTIVE locations, so a closed venue simply stops
        // arriving. Without this it stayed in the questionnaire forever: three closed
        // Zaporizhzhia Volklands were still offered to candidates in September 2026.
        const transaction = transactionStub();
        prismaMock.$transaction.mockImplementation((callback: (tx: ReturnType<typeof transactionStub>) => unknown) =>
            callback(transaction));
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot([{ telegramId: "486213975" }]));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await new AwsBusinessSyncService().syncAll();

        expect(transaction.location.updateMany).toHaveBeenCalledWith({
            where: {
                awsPublicId: { not: null, notIn: ["22222222-2222-4222-8222-222222222200"] },
                NOT: { isHidden: true, isHiddenFromCandidates: true },
            },
            data: { isHidden: true, isHiddenFromCandidates: true },
        });
        // Строки, которых вебапп не знает вовсе, прячутся только от кандидаток:
        // закрытыми их назвать нельзя, логистика и справочники их видят.
        expect(transaction.location.updateMany).toHaveBeenCalledWith({
            where: { awsPublicId: null, isHiddenFromCandidates: false },
            data: { isHiddenFromCandidates: true },
        });
    });
});

describe("AwsBusinessSyncService — hiring deficit from the web app", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.staffProfile.count.mockResolvedValue(0);
        prismaMock.staffProfile.findMany.mockResolvedValue([]);
        prismaMock.user.findMany.mockResolvedValue([]);
        prismaMock.systemState.upsert.mockResolvedValue(undefined);
    });

    async function syncWith(location: Record<string, unknown>) {
        const transaction = transactionStub();
        prismaMock.$transaction.mockImplementation((callback: (tx: ReturnType<typeof transactionStub>) => unknown) =>
            callback(transaction));
        const base = snapshot([{ telegramId: "486213975" }]);
        awsBusinessClientMock.snapshot.mockResolvedValue({ ...base, locations: [{ ...base.locations[0], ...location }] });
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");
        await new AwsBusinessSyncService().syncAll();
        return transaction;
    }

    it("writes the web app's deficit into neededCount — one truth for the questionnaire", async () => {
        const transaction = await syncWith({ hiringDeficit: 2 });

        expect(transaction.location.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ neededCount: 2 }),
        }));
    });

    it("leaves neededCount alone when an older backend omits the field", async () => {
        const transaction = await syncWith({});

        const data = transaction.location.create.mock.calls[0]?.[0]?.data;
        expect(data).not.toHaveProperty("neededCount");
    });
});

describe("AwsBusinessSyncService — parcels of a photographer leaving the team", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.staffProfile.count.mockResolvedValue(0);
        prismaMock.staffProfile.findMany.mockResolvedValue([]);
        prismaMock.user.findMany.mockResolvedValue([]);
        prismaMock.systemState.upsert.mockResolvedValue(undefined);
    });

    function stubWithParcels() {
        return { ...transactionStub(), parcel: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    }

    // 01.10.2026: 10 посилок лишились за звільненими, і фото не могла завантажити
    // жодна інша фотографиня.
    it("releases her parcels at the moment the web app deactivates her", async () => {
        const transaction = stubWithParcels();
        transaction.staffProfile.findUnique.mockResolvedValue({ id: "staff-9", deactivatedAt: null, isActive: true });
        prismaMock.$transaction.mockImplementation(((callback: (tx: unknown) => unknown) => callback(transaction)) as never);
        const base = snapshot([{ telegramId: "486213975" }]);
        awsBusinessClientMock.snapshot.mockResolvedValue({
            ...base,
            employees: base.employees.map((employee) => ({ ...employee, status: "INACTIVE" })),
        });
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await new AwsBusinessSyncService().syncAll();

        expect(transaction.parcel.updateMany).toHaveBeenCalledWith({
            where: { responsibleStaffId: { in: ["staff-9"] }, status: "DELIVERED" },
            data: { responsibleStaffId: null, acceptedAt: null },
        });
        expect(transaction.parcel.updateMany).toHaveBeenCalledWith({
            where: { responsibleStaffId: { in: ["staff-9"] }, status: "PICKUP_IN_PROGRESS" },
            data: { responsibleStaffId: null, acceptedAt: null, status: "ARRIVED" },
        });
    });

    it("leaves parcels of someone deactivated long ago untouched", async () => {
        const transaction = stubWithParcels();
        transaction.staffProfile.findUnique.mockResolvedValue({
            id: "staff-9", deactivatedAt: new Date("2026-08-01T00:00:00Z"), isActive: false,
        });
        prismaMock.$transaction.mockImplementation(((callback: (tx: unknown) => unknown) => callback(transaction)) as never);
        const base = snapshot([{ telegramId: "486213975" }]);
        awsBusinessClientMock.snapshot.mockResolvedValue({
            ...base,
            employees: base.employees.map((employee) => ({ ...employee, status: "INACTIVE" })),
        });
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await new AwsBusinessSyncService().syncAll();

        expect(transaction.parcel.updateMany).not.toHaveBeenCalled();
    });

    it("releases parcels of someone who dropped out of the snapshot", async () => {
        const transaction = stubWithParcels();
        // Перший виклик — пошук тих, кого знімок більше не містить; далі синк змін.
        transaction.staffProfile.findMany.mockResolvedValueOnce([{ id: "staff-gone" }]);
        prismaMock.$transaction.mockImplementation(((callback: (tx: unknown) => unknown) => callback(transaction)) as never);
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot([{ telegramId: "486213975" }]));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await new AwsBusinessSyncService().syncAll();

        expect(transaction.parcel.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { responsibleStaffId: { in: ["staff-gone"] }, status: "DELIVERED" },
        }));
    });
});

describe("AwsBusinessSyncService — legacy bot block", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.staffProfile.count.mockResolvedValue(0);
        prismaMock.staffProfile.findMany.mockResolvedValue([]);
        prismaMock.user.findMany.mockResolvedValue([]);
        prismaMock.systemState.upsert.mockResolvedValue(undefined);
    });

    // isBlocked ставив лише старий синк чорного списку; у режимі вебаппа його ніхто
    // не знімав, і знову найнята людина бачила від бота тільки «System Maintenance».
    it("unblocks an employee the web app has active", async () => {
        const transaction = transactionStub();
        prismaMock.$transaction.mockImplementation(((callback: (tx: unknown) => unknown) => callback(transaction)) as never);
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot([{ telegramId: "486213975" }]));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await new AwsBusinessSyncService().syncAll();

        expect(transaction.user.upsert).toHaveBeenCalledWith(expect.objectContaining({
            update: expect.objectContaining({ isBlocked: false }),
        }));
    });
});

const syncUserAccess = vi.fn();
vi.mock("../access-service.js", () => ({ accessService: { syncUserAccess: (...a: unknown[]) => syncUserAccess(...a) } }));

describe("AwsBusinessSyncService — employee dropped from the snapshot", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.staffProfile.count.mockResolvedValue(0);
        prismaMock.staffProfile.findMany.mockResolvedValue([]);
        prismaMock.user.findMany.mockResolvedValue([]);
        prismaMock.systemState.upsert.mockResolvedValue(undefined);
    });

    // Вебапп ставить рядок на відкликання доступу лише при деактивації. Видалена
    // або з новим Telegram людина просто зникала зі знімка й лишалась у чатах.
    it("removes her from the team chats after the sync commits", async () => {
        const transaction = { ...transactionStub(), parcel: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } };
        transaction.staffProfile.findMany.mockResolvedValueOnce([{ id: "staff-gone", user: { telegramId: 555n } }]);
        prismaMock.$transaction.mockImplementation(((callback: (tx: unknown) => unknown) => callback(transaction)) as never);
        awsBusinessClientMock.snapshot.mockResolvedValue(snapshot([{ telegramId: "486213975" }]));
        const { AwsBusinessSyncService } = await import("../aws-business-sync.js");

        await new AwsBusinessSyncService().syncAll();

        expect(syncUserAccess).toHaveBeenCalledWith(555n, "Absent from the web app employee snapshot");
    });
});
