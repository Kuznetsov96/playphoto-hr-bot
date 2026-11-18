import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { Api } from "grammy";
import { BlockedRecipientError, blocklistOutgoingTransformer, installBlocklistOutgoingGuard, isBlocklistedRecipientError } from "../telegram-blocklist-outgoing.js";
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

describe("audit rate limit and failure isolation", () => {
    afterEach(() => vi.useRealTimers());

    it("audits once per telegramId per hour, again after the hour", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
        state.blocked.add(555001);
        const attempt = () => call({ chat_id: 555001, text: "x" }).run().catch(() => undefined);

        await attempt();
        await attempt();
        await attempt();
        expect(audit).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date("2026-11-18T10:59:00Z"));
        await attempt();
        expect(audit).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date("2026-11-18T11:00:01Z"));
        await attempt();
        expect(audit).toHaveBeenCalledTimes(2);
    });

    it("a different id is audited separately", async () => {
        state.blocked.add(555002);
        state.blocked.add(555003);
        await call({ chat_id: 555002 }).run().catch(() => undefined);
        await call({ chat_id: 555003 }).run().catch(() => undefined);
        expect(audit).toHaveBeenCalledTimes(2);
    });

    it("audit failure never replaces BlockedRecipientError", async () => {
        state.blocked.add(555004);
        audit.mockImplementationOnce(() => { throw new Error("disk full"); });
        const { prev, run } = call({ chat_id: 555004, text: "x" });
        await expect(run()).rejects.toBeInstanceOf(BlockedRecipientError);
        expect(prev).not.toHaveBeenCalled();
    });
});

describe("isBlocklistedRecipientError", () => {
    it("recognises only BlockedRecipientError", () => {
        expect(isBlocklistedRecipientError(new BlockedRecipientError())).toBe(true);
        expect(isBlocklistedRecipientError(new Error("Forbidden: bot was blocked by the user"))).toBe(false);
        expect(isBlocklistedRecipientError(null)).toBe(false);
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

describe("guard is the last config.use( for its instance", () => {
    const cases = ["src/core/bot.ts", "src/workers/index.ts"];
    for (const f of cases) {
        it(f, () => {
            const lines = readFileSync(resolve(process.cwd(), f), "utf8").split("\n");
            const installs = lines.flatMap((l, i) => {
                const m = l.match(/installBlocklistOutgoingGuard\((\w+)\.api\)/);
                return m ? [{ i, v: m[1]! }] : [];
            });
            expect(installs.length).toBeGreaterThan(0);
            for (const { i, v } of installs) {
                const after = lines.slice(i + 1).filter(l => l.includes(`${v}.api.config.use(`));
                expect(after, `config.use( after the guard for ${v} in ${f}`).toEqual([]);
            }
        });
    }
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
