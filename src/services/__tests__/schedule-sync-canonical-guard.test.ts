import { describe, expect, it, vi } from "vitest";

/**
 * Составление графика живёт в вебе, а зеркало бота наполняется из канона каждые
 * пять минут (aws-business-sync). Google Sheets остался только как исторический
 * путь и обязан молчать, пока BUSINESS_DATA_SOURCE=aws.
 *
 * Цена ошибки видна по коду самого sheets-пути: он делает
 * deleteManyByDateRange по всему диапазону и создаёт смены заново. Один запуск
 * при живом каноне стёр бы зеркало и подменил бы его содержимым таблицы —
 * до следующего тика синка, который вернул бы всё обратно. Фотографы в это
 * окно видели бы чужой график.
 *
 * Поэтому здесь проверяется не «в коде есть if», а что каждая точка входа
 * действительно уходит в канонический сервис и НЕ трогает Google Sheets.
 */

const awsSyncSchedule = vi.fn().mockResolvedValue({ success: true, count: 0, source: "AWS" });
const awsSyncTeam = vi.fn().mockResolvedValue({ success: true, count: 0, source: "AWS" });
const awsSyncBlocklist = vi.fn().mockResolvedValue({ success: true, count: 0, source: "AWS" });

vi.mock("../aws-business-sync.js", () => ({
    awsBusinessSyncService: {
        syncSchedule: awsSyncSchedule,
        syncTeam: awsSyncTeam,
        syncBlocklist: awsSyncBlocklist,
        syncAll: vi.fn(),
        startLoop: vi.fn(),
    },
}));

vi.mock("../../config.js", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("../../config.js");
    return { ...actual, BUSINESS_DATA_SOURCE: "aws" };
});

const workShiftWrites = {
    create: vi.fn(),
    deleteManyByDateRange: vi.fn(),
    deleteManyForStaffSince: vi.fn(),
    countInRange: vi.fn().mockResolvedValue(0),
};

vi.mock("../../repositories/work-shift-repository.js", () => ({
    workShiftRepository: workShiftWrites,
}));

const { scheduleSyncService } = await import("../schedule-sync.js");

describe("schedule sync under BUSINESS_DATA_SOURCE=aws", () => {
    it("delegates the schedule sync to the canonical projection", async () => {
        await scheduleSyncService.syncSchedule("Актуальний розклад");

        expect(awsSyncSchedule).toHaveBeenCalled();
    });

    it("never rewrites the local mirror from the spreadsheet", async () => {
        await scheduleSyncService.syncSchedule("Актуальний розклад");

        expect(workShiftWrites.deleteManyByDateRange).not.toHaveBeenCalled();
        expect(workShiftWrites.create).not.toHaveBeenCalled();
    });

    it("delegates the team sync too, so no staff deactivation clears shifts", async () => {
        await scheduleSyncService.syncTeam();

        expect(awsSyncTeam).toHaveBeenCalled();
        expect(workShiftWrites.deleteManyForStaffSince).not.toHaveBeenCalled();
    });
});
