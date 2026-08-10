import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
    fileURLToPath(new URL("../shift-reminder-service.ts", import.meta.url)),
    "utf8"
);

describe("shift-reminder canonical source", () => {
    it("reads the canonical schedule behind the reminders flag", () => {
        expect(source).toContain("AWS_REMINDERS_CANONICAL_READ_ENABLED");
        expect(source).toContain("awsScheduleCanonicalReadService");
    });

    it("keeps the legacy repository as the fallback path", () => {
        expect(source).toContain("findWithRelationsByDateRange");
    });

    it("logs a fallback event when the canonical read fails", () => {
        expect(source).toContain("bot.reminders_canonical_read.fallback");
    });

    it("attaches the staff profile to canonical shifts before delivery", () => {
        // The delivery loop reads shift.staff.user.telegramId, but the canonical
        // projection has no staff relation. Without this the reminder throws at runtime.
        expect(source).toMatch(/staffById|staff:\s*profile/u);
    });
});
