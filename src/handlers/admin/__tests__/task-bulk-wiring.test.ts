import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Task 9/10 wiring is exactly two allowlists (role-check filter + staff shield)
 * and a set of teardown sites spread across the admin handler tree. None of
 * this is unit-testable through normal exports — the allowlist is an inline
 * Composer filter predicate, and the teardown sites are scattered `delete`
 * statements inside dynamic-menu callbacks. A source-text pin is the cheap
 * way to guard the two ways this silently regresses: someone reintroduces a
 * flow-start `delete ctx.session.taskCreation;` without the matching
 * `bulkTaskData` line, or the `tbk_` prefix falls out of an allowlist during
 * a refactor of the surrounding startsWith chain.
 */

function read(relativePath: string): string {
    const path = fileURLToPath(new URL(relativePath, import.meta.url));
    return readFileSync(path, "utf8");
}

describe("bulk task wiring pins", () => {
    it("mounts the task callback role guard BEFORE the task composers", () => {
        // Порядок здесь и есть защита. grammY выполняет middleware в порядке регистрации,
        // а обработчики задач завершают апдейт без next() — всё, что смонтировано после них,
        // для tbk_/tas_/task_/b_ не выполняется. Раньше на этом месте стоял грep строки
        // startsWith("tbk_") в protectedAdminCallbacks: он зеленел, хотя requireRole
        // не вызывался ни разу. Поведение гейта покрыто task-callback-role-guard.test.ts.
        const source = read("../index.ts");
        const guardAt = source.indexOf("adminHandlers.use(buildTaskCallbackGuard());");
        const firstTaskComposerAt = source.indexOf("adminHandlers.use(adminBroadcastHandlers);");
        const bulkComposerAt = source.indexOf("adminHandlers.use(taskBulkHandlers);");

        expect(guardAt).toBeGreaterThan(-1);
        expect(firstTaskComposerAt).toBeGreaterThan(-1);
        expect(guardAt).toBeLessThan(firstTaskComposerAt);
        expect(guardAt).toBeLessThan(bulkComposerAt);
    });

    it("keeps the task prefixes out of protectedAdminCallbacks, which never runs for them", () => {
        const source = read("../index.ts");
        const filterBlock = source.slice(
            source.indexOf("const protectedAdminCallbacks"),
            source.indexOf("));", source.indexOf("const protectedAdminCallbacks")),
        );
        for (const prefix of ["tbk_", "tas_", "task_", "b_"]) {
            expect(filterBlock, `${prefix} advertises protection this filter cannot provide`)
                .not.toContain(`c.callbackQuery.data.startsWith("${prefix}")`);
        }
    });

    it("staff shield in handlers/index.ts includes the tbk_ prefix", () => {
        const source = read("../../index.ts");
        expect(source).toMatch(/data\.startsWith\("tbk_"\)/);
    });

    it("taskBulkHandlers is mounted and handleBulkTaskContent is wired into the message funnel", () => {
        const source = read("../index.ts");
        expect(source).toContain("adminHandlers.use(taskBulkHandlers);");
        expect(source).toContain("if (await handleBulkTaskContent(ctx)) return;");
    });

    it("every site that tears down taskCreation also tears down bulkTaskData", () => {
        // Mirrors: grep -rn "delete ctx.session.taskCreation" src/ | grep -v __tests__
        const files = [
            "../../../core/bot.ts",
            "../../commands.ts",
            "../task-flow.ts",
            "../search.ts",
            "../broadcast.ts",
            "../magnet-counter.ts",
            "../logistics.ts",
            "../team.ts",
            "../manual-channel-access.ts",
            "../system.ts",
            "../index.ts",
        ];

        for (const relativePath of files) {
            const source = read(relativePath);
            const taskCreationDeletes = (source.match(/delete ctx\.session\.taskCreation;/g) || []).length;
            const bulkTaskDataDeletes = (source.match(/delete ctx\.session\.bulkTaskData;/g) || []).length;
            expect(
                bulkTaskDataDeletes,
                `${relativePath}: expected ${taskCreationDeletes} bulkTaskData teardown(s) to match taskCreation teardown(s)`,
            ).toBe(taskCreationDeletes);
        }
    });

    it("task-creation.ts's own flow-start clears bulkTaskData (but not its own taskCreation)", () => {
        const source = read("../task-creation.ts");
        const startBlock = source.slice(
            source.indexOf('composer.callbackQuery(/^task_add_start'),
            source.indexOf('const data = ctx.callbackQuery.data.replace("task_add_start"'),
        );
        expect(startBlock).toContain("delete ctx.session.bulkTaskData;");
    });
});
