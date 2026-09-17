import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCompletionMode } from "@prisma/client";

const { create, findShiftWithLocationOnDate, findById } = vi.hoisted(() => ({
    create: vi.fn(),
    findShiftWithLocationOnDate: vi.fn(),
    findById: vi.fn(),
}));

vi.mock("../../repositories/task-repository.js", () => ({
    taskRepository: { create },
}));

vi.mock("../../repositories/work-shift-repository.js", () => ({
    workShiftRepository: { findShiftWithLocationOnDate },
}));

vi.mock("../../repositories/staff-repository.js", () => ({
    staffRepository: { findById },
}));

import { taskService } from "../task-service.js";

const VALID_STAFF_A = "clx0000000000000000000a01";
const VALID_STAFF_B = "clx0000000000000000000b02";
const VALID_STAFF_C = "clx0000000000000000000c03";

function baseInput(staffIds: string[]) {
    return {
        staffIds,
        taskText: "Clean the studio",
        workDate: new Date("2026-09-20T00:00:00"),
        deadlineTime: "23:59",
        fileId: null,
        createdById: "555",
        completionMode: TaskCompletionMode.QUICK,
        telegramIdByStaffId: new Map<string, bigint | null>(
            staffIds.map(id => [id, BigInt(1000)]),
        ),
    };
}

describe("taskService.createTasksBulk", () => {
    beforeEach(() => {
        create.mockReset();
        findShiftWithLocationOnDate.mockReset();
        findById.mockReset();
        findShiftWithLocationOnDate.mockResolvedValue({ location: { city: "Kyiv", name: "Podil" } });
        findById.mockResolvedValue(null);
        create.mockImplementation(async () => ({ id: `task-${create.mock.calls.length}` }));
    });

    it("creates one task per staff member", async () => {
        const result = await taskService.createTasksBulk(baseInput([VALID_STAFF_A, VALID_STAFF_B]));

        expect(create).toHaveBeenCalledTimes(2);
        expect(result.created).toHaveLength(2);
        expect(result.failed).toEqual([]);
    });

    it("keeps going when one task fails and reports it", async () => {
        create.mockImplementationOnce(async () => ({ id: "task-1" }));
        create.mockImplementationOnce(async () => { throw new Error("db is down"); });
        create.mockImplementationOnce(async () => ({ id: "task-3" }));

        const result = await taskService.createTasksBulk(baseInput([VALID_STAFF_A, VALID_STAFF_B, VALID_STAFF_C]));

        expect(create).toHaveBeenCalledTimes(3);
        expect(result.created.map(c => c.staffId)).toEqual([VALID_STAFF_A, VALID_STAFF_C]);
        expect(result.failed).toEqual([{ staffId: VALID_STAFF_B, error: "db is down" }]);
    });

    it("records a validation failure as failed rather than throwing", async () => {
        const input = { ...baseInput([VALID_STAFF_A]), taskText: "" };

        const result = await taskService.createTasksBulk(input);

        expect(result.created).toEqual([]);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0]!.staffId).toBe(VALID_STAFF_A);
    });

    it("carries the telegram id through so the caller can notify without another query", async () => {
        const input = baseInput([VALID_STAFF_A]);
        input.telegramIdByStaffId.set(VALID_STAFF_A, BigInt(4242));

        const result = await taskService.createTasksBulk(input);

        expect(result.created[0]).toEqual(expect.objectContaining({
            staffId: VALID_STAFF_A,
            telegramId: BigInt(4242),
        }));
    });

    it("reports a null telegram id instead of failing the task", async () => {
        const input = baseInput([VALID_STAFF_A]);
        input.telegramIdByStaffId.set(VALID_STAFF_A, null);

        const result = await taskService.createTasksBulk(input);

        expect(result.created).toHaveLength(1);
        expect(result.created[0]!.telegramId).toBeNull();
    });

    it("passes the chosen completion mode to every task", async () => {
        const input = { ...baseInput([VALID_STAFF_A]), completionMode: TaskCompletionMode.PROOF_REQUIRED };

        await taskService.createTasksBulk(input);

        expect(create).toHaveBeenCalledWith(expect.objectContaining({
            completionMode: TaskCompletionMode.PROOF_REQUIRED,
        }));
    });
});
