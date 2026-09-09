import { describe, expect, it, vi } from "vitest";

vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { updateUserCommands } = await import("../command-manager.js");

function makeCtx() {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);
    return {
        ctx: { from: { id: 42 }, api: { setMyCommands } } as any,
        setMyCommands,
    };
}

async function commandsFor(role: string, adminRole?: string) {
    const { ctx, setMyCommands } = makeCtx();
    await updateUserCommands(ctx, role, adminRole as any);
    return setMyCommands.mock.calls[0]?.[0] as Array<{ command: string; description: string }>;
}

describe("updateUserCommands", () => {
    /**
     * Роль ментора вилучена з бота разом із меню й сервісом, а обробника
     * команди /mentor не існувало вже давно: у списку висів пункт, тап по
     * якому не робив нічого взагалі.
     */
    it("не пропонує /mentor жодній ролі", async () => {
        for (const [role, adminRole] of [
            ["ADMIN", "SUPER_ADMIN"],
            ["ADMIN", "CO_FOUNDER"],
            ["ADMIN", "HR_LEAD"],
            ["ADMIN", "MENTOR_LEAD"],
            ["STAFF", undefined],
            ["CANDIDATE", undefined],
            ["OTHER", undefined],
        ] as const) {
            const commands = await commandsFor(role, adminRole);
            expect(commands.map((c) => c.command)).not.toContain("mentor");
        }
    });

    it("пропонує лише команди, для яких є обробники", async () => {
        // Обробники: /start, /support (див. handlers/commands.ts і support.ts).
        const handled = new Set(["start", "support"]);

        for (const [role, adminRole] of [
            ["ADMIN", "SUPER_ADMIN"],
            ["ADMIN", "MENTOR_LEAD"],
            ["STAFF", undefined],
            ["CANDIDATE", undefined],
        ] as const) {
            const commands = await commandsFor(role, adminRole);
            for (const { command } of commands) {
                expect(handled).toContain(command);
            }
        }
    });

    it("кожна роль отримує щонайменше /start", async () => {
        for (const [role, adminRole] of [
            ["ADMIN", "SUPER_ADMIN"],
            ["ADMIN", "MENTOR_LEAD"],
            ["STAFF", undefined],
            ["CANDIDATE", undefined],
            ["OTHER", undefined],
        ] as const) {
            const commands = await commandsFor(role, adminRole);
            expect(commands.map((c) => c.command)).toContain("start");
        }
    });

    it("ставить команди саме для чату користувача", async () => {
        const { ctx, setMyCommands } = makeCtx();
        await updateUserCommands(ctx, "CANDIDATE");

        expect(setMyCommands.mock.calls[0]?.[1]).toEqual({
            scope: { type: "chat", chat_id: 42 },
        });
    });
});
