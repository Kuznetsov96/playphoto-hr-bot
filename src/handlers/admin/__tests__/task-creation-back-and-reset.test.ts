import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { taskLocationBackCallback } from "../task-creation.js";

function read(relativePath: string): string {
    const path = fileURLToPath(new URL(relativePath, import.meta.url));
    return readFileSync(path, "utf8");
}

describe("taskLocationBackCallback", () => {
    it("points back at the chosen location when one was actually picked", () => {
        expect(taskLocationBackCallback({ locationId: "loc-42" })).toBe("tas_loc_loc-42");
    });

    // This is the ITEM 3 regression: a Back button built as `tas_loc_undefined`
    // resolves to no location (locationRepository.findById("undefined") → null),
    // which shows a "Location not found" alert and freezes the screen — the
    // only escape was /start. Falling back to a real, always-rendering screen
    // closes that dead end regardless of how a future code path might reach
    // the entering_text family of screens without a locationId set.
    it("falls back to the date-entry screen when locationId is missing", () => {
        expect(taskLocationBackCallback({})).toBe("task_add_by_date");
        expect(taskLocationBackCallback(undefined)).toBe("task_add_by_date");
    });
});

describe("task_add_start clears its own taskCreation slice (ITEM 2)", () => {
    // Redis sessions live 24h. Every other admin flow's start handler clears
    // taskCreation as part of resetting cross-flow state; this handler used to
    // be the one exception, only lazily re-initializing it when *absent* — so
    // an abandoned wizard from a day earlier came back to life on the next
    // "New Task" tap: a stale taskText jumped straight to the deadline screen,
    // and a stale selectedStaffIds (from the now-removed direct-assignment
    // short-circuit) skipped city/location selection outright.
    it("deletes ctx.session.taskCreation inside the task_add_start handler", () => {
        const source = read("../task-creation.ts");
        const startBlock = source.slice(
            source.indexOf("composer.callbackQuery(/^task_add_start"),
            source.indexOf('const data = ctx.callbackQuery.data.replace("task_add_start"'),
        );
        expect(startBlock).toContain("delete ctx.session.taskCreation;");
    });

    it("removed the dead direct-assignment short-circuit that never received a locationId", () => {
        const source = read("../task-creation.ts");
        expect(source).not.toContain("Direct Task Assignment");
        expect(source).not.toContain("taskCreation.staffId");
    });
});
