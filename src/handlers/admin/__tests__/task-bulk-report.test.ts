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
        }, []);

        expect(report).toContain("2");
        expect(report).not.toContain("not created");
        expect(report).not.toContain("not notified");
    });

    it("counts created tasks, not selected staff", () => {
        const report = buildResultReport({
            created: [{ staffId: "s1", taskId: "t1", telegramId: BigInt(1) }],
            failed: [{ staffId: "s2", error: "db is down" }],
        }, []);

        expect(report).toContain("1");
        expect(report).toContain("not created");
        expect(report).toContain("db is down");
    });

    it("separates a delivery problem from a creation problem", () => {
        const report = buildResultReport({
            created: [{ staffId: "s1", taskId: "t1", telegramId: null }],
            failed: [],
        }, ["Шевченко Тарас"]);

        expect(report).toContain("not notified");
        expect(report).toContain("Шевченко Тарас");
        expect(report).not.toContain("not created");
    });
});
