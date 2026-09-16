import { describe, expect, it } from "vitest";
import { buildResultReport } from "../task-bulk.js";

describe("buildResultReport", () => {
    it("reports a clean run", () => {
        const report = buildResultReport({
            created: [
                { staffId: "s1", taskId: "t1", telegramId: BigInt(1) },
                { staffId: "s2", taskId: "t2", telegramId: BigInt(2) },
            ],
            failed: [],
        }, [], new Map());

        expect(report).toContain("2 task(s) created.");
        expect(report).not.toContain("not created");
        expect(report).not.toContain("not notified");
    });

    it("counts created tasks, not selected staff", () => {
        const report = buildResultReport({
            created: [{ staffId: "s1", taskId: "t1", telegramId: BigInt(1) }],
            failed: [{ staffId: "s2", error: "db is down" }],
        }, [], new Map());

        expect(report).toContain("1 task(s) created.");
        expect(report).toContain("1 not created:");
        expect(report).toContain("db is down");
    });

    it("separates a delivery problem from a creation problem", () => {
        const report = buildResultReport({
            created: [{ staffId: "s1", taskId: "t1", telegramId: null }],
            failed: [],
        }, ["Шевченко Тарас"], new Map());

        expect(report).toContain("not notified");
        expect(report).toContain("Шевченко Тарас");
        expect(report).not.toContain("not created");
    });

    it("shows a human name for a failed creation, not the raw staff id", () => {
        const report = buildResultReport({
            created: [],
            failed: [{ staffId: "cmfx8k2p0001abcd", error: "db is down" }],
        }, [], new Map([["cmfx8k2p0001abcd", "Шевченко Тарас"]]));

        expect(report).toContain("Шевченко Тарас");
        expect(report).not.toContain("cmfx8k2p0001abcd");
    });

    it("falls back to the staff id when no name is known", () => {
        const report = buildResultReport({
            created: [],
            failed: [{ staffId: "cmfx8k2p0001abcd", error: "db is down" }],
        }, [], new Map());

        expect(report).toContain("cmfx8k2p0001abcd");
    });

    it("marks the header as failed when nothing was created", () => {
        const report = buildResultReport({
            created: [],
            failed: [{ staffId: "s1", error: "db is down" }],
        }, [], new Map());

        expect(report).toContain("0 task(s) created.");
        expect(report).not.toMatch(/^✅/);
    });

    it("marks the header as partial when some but not all tasks were created", () => {
        const report = buildResultReport({
            created: [{ staffId: "s1", taskId: "t1", telegramId: BigInt(1) }],
            failed: [{ staffId: "s2", error: "db is down" }],
        }, [], new Map());

        expect(report).toContain("1 task(s) created.");
        expect(report).not.toMatch(/^✅/);
    });

    it("escapes HTML in an error message instead of passing it through raw", () => {
        const report = buildResultReport({
            created: [],
            failed: [{ staffId: "s1", error: "<script>alert(1)</script>" }],
        }, [], new Map());

        expect(report).not.toContain("<script>");
        expect(report).toContain("&lt;script&gt;");
    });

    it("truncates a long error message instead of dumping raw Zod JSON", () => {
        const longError = "x".repeat(500);
        const report = buildResultReport({
            created: [],
            failed: [{ staffId: "s1", error: longError }],
        }, [], new Map());

        expect(report.length).toBeLessThan(longError.length + 200);
        expect(report).toContain("…");
    });
});
