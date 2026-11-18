import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const state = vi.hoisted(() => ({ loaded: true, ensure: true, blocked: new Set<number>([838713502]) }));
const audit = vi.hoisted(() => vi.fn());

vi.mock("../telegram-blocklist.js", () => ({
    telegramBlocklist: {
        isLoaded: () => state.loaded,
        has: (id: number | bigint) => state.blocked.has(Number(id)),
        ensureLoaded: async () => state.ensure,
    },
}));
vi.mock("../../core/audit-logger.js", () => ({ securityAudit: audit }));

import { Api } from "grammy";
import { BlockedRecipientError, blocklistOutgoingTransformer, installBlocklistOutgoingGuard } from "../telegram-blocklist-outgoing.js";
import { isBotBlocked } from "../../utils/bot-blocked.js";

const call = (payload: any, method = "sendMessage") => {
    const prev = vi.fn(async () => ({ ok: true, result: true }) as any);
    return { prev, run: () => blocklistOutgoingTransformer(prev as any, method as any, payload, undefined) };
};

beforeEach(() => {
    state.loaded = true;
    state.ensure = true;
    audit.mockClear();
});

describe("blocklistOutgoingTransformer", () => {
    it("blocked chat_id: prev not called, BlockedRecipientError, not isBotBlocked, no text in audit", async () => {
        const { prev, run } = call({ chat_id: 838713502, text: "secret text" });
        const err = await run().catch(e => e);
        expect(err).toBeInstanceOf(BlockedRecipientError);
        expect(isBotBlocked(err)).toBe(false);
        expect(prev).not.toHaveBeenCalled();
        expect(audit).toHaveBeenCalledTimes(1);
        expect(audit.mock.calls[0]![0]).toMatchObject({
            event: "security.blocked_recipient_skipped", result: "failed", actorType: "system",
            telegramId: 838713502, entityType: "bot", context: { method: "sendMessage" },
        });
        expect(JSON.stringify(audit.mock.calls)).not.toContain("secret text");
    });

    it("string chat_id is blocked", async () => {
        const { prev, run } = call({ chat_id: "838713502", text: "x" });
        await expect(run()).rejects.toBeInstanceOf(BlockedRecipientError);
        expect(prev).not.toHaveBeenCalled();
    });

    it("not blocked passes through", async () => {
        const { prev, run } = call({ chat_id: 1, text: "x" });
        await run();
        expect(prev).toHaveBeenCalledTimes(1);
    });

    it("negative chat_id and @name pass through", async () => {
        for (const chat_id of [-100123, "@channel"]) {
            const { prev, run } = call({ chat_id });
            await run();
            expect(prev).toHaveBeenCalledTimes(1);
        }
    });

    it("payload without chat_id passes through", async () => {
        const { prev, run } = call({}, "getMe");
        await run();
        expect(prev).toHaveBeenCalledTimes(1);
    });

    it("list failed to load: prev called", async () => {
        state.loaded = false;
        state.ensure = false;
        const { prev, run } = call({ chat_id: 838713502, text: "x" });
        await run();
        expect(prev).toHaveBeenCalledTimes(1);
    });

    it("list loads lazily and then blocks", async () => {
        state.loaded = false;
        state.ensure = true;
        const { prev, run } = call({ chat_id: 838713502, text: "x" });
        await expect(run()).rejects.toBeInstanceOf(BlockedRecipientError);
        expect(prev).not.toHaveBeenCalled();
    });
});

describe("install order (grammY: later config.use wraps earlier)", () => {
    it("guard installed last never reaches earlier transformers or the network", async () => {
        const api = new Api("123:test");
        const reached = vi.fn();
        api.config.use(async (prev, method, payload, signal) => {
            reached(method);
            return prev(method, payload, signal);
        });
        installBlocklistOutgoingGuard(api);
        await expect(api.sendMessage(838713502, "hi")).rejects.toBeInstanceOf(BlockedRecipientError);
        expect(reached).not.toHaveBeenCalled();
    });
});

describe("every new Bot( site installs the guard", () => {
    const files = [
        "src/core/bot.ts", "src/workers/index.ts", "src/services/logistics-service.ts",
        "src/services/parcel-followup-service.ts", "src/services/schedule-sync.ts", "src/services/hr-service.ts",
    ];
    for (const f of files) {
        it(f, () => {
            const lines = readFileSync(resolve(process.cwd(), f), "utf8").split("\n");
            const bots = lines.flatMap((l, i) => (l.includes("new Bot") ? [i] : []));
            expect(bots.length).toBeGreaterThan(0);
            for (const i of bots) {
                const near = lines.slice(i, i + 12).join("\n");
                expect(near).toContain("installBlocklistOutgoingGuard(");
            }
        });
    }
});
