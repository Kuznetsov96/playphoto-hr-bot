import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrammyError, HttpError } from "grammy";

vi.mock("../../config/callback-secret.js", () => ({ CALLBACK_SECRET: "test-secret" }));
const { redis } = vi.hoisted(() => ({
    redis: { get: vi.fn(), set: vi.fn(), sadd: vi.fn(), srem: vi.fn(), smembers: vi.fn(), multi: vi.fn() },
}));
vi.mock("../../core/redis.js", () => ({ redis }));
const { logBusinessEvent } = vi.hoisted(() => ({ logBusinessEvent: vi.fn() }));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent }));

const { createShootTaskDispatcher, redisSentStore, startPolling } = await import("../shoot-task-dispatcher.js");
const { AwsBusinessApiError } = await import("../aws-business-client.js");

const item = {
    publicId: "0f8fad5b-d9cb-469f-a165-70867728950e", ref: "abcdefgh2345", kind: "ASSIGNED" as const, telegramId: "1164289764",
    shoot: { clientName: "Олена", childName: null, phone: "+380671231301", notes: null, location: { name: "Dragon Park 1", city: "Lviv", branch: null },
        shootOn: "2030-03-16", intervals: [{ start: "15:00", end: "16:00" }], durationMinutes: 60 },
    dueOn: "2030-03-19", canMoveDue: false, overdueDays: null, returnComment: null, pathB: false, targetMessageId: null,
};
const redact = { ...item, kind: "REDACT" as const, targetMessageId: 777, shoot: { ...item.shoot, phone: null } };

function memoryStore() {
    const map = new Map<string, number>();
    const open = new Set<string>();
    return {
        get: vi.fn(async (id: string) => map.get(id) ?? null),
        remember: vi.fn(async (id: string, m: number) => {
            map.set(id, m);
            open.add(id);
        }),
        unconfirmed: vi.fn(async () => [...open]),
        confirmed: vi.fn(async (id: string) => void open.delete(id)),
        map,
        open,
    };
}
function client(items: unknown[], invalid: string[] = [], unidentifiableCount = 0) {
    return {
        pendingShootTasks: vi.fn().mockResolvedValue({ items, invalidPublicIds: invalid, unidentifiableCount }),
        markShootTaskDelivered: vi.fn().mockResolvedValue(undefined),
        markShootTaskFailed: vi.fn().mockResolvedValue(undefined),
    };
}
const tgError = (code: number, description: string, method = "editMessageText") =>
    new GrammyError(description, { ok: false, error_code: code, description }, method, {});

beforeEach(() => {
    logBusinessEvent.mockReset();
});

describe("ShootTaskDispatcher", () => {
    it("sends to the photographer and reports the message id", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 501 }), editMessageText: vi.fn() };
        const c = client([item]);
        const store = memoryStore();
        await createShootTaskDispatcher(api as never, c as never, store).runOnce();
        expect(api.sendMessage).toHaveBeenCalledWith(1164289764, expect.stringContaining("Тобі призначено зйомку."), expect.objectContaining({ parse_mode: "HTML" }));
        expect(store.remember).toHaveBeenCalledWith(item.publicId, 501);
        expect(c.markShootTaskDelivered).toHaveBeenCalledWith(item.publicId, 501);
        expect(store.open.size).toBe(0);
    });

    it("a second poll returning the same row after a lost «delivered» does not send again", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 501 }), editMessageText: vi.fn() };
        const store = memoryStore();
        const c = client([item]);
        c.markShootTaskDelivered.mockRejectedValueOnce(new Error("api down")).mockRejectedValueOnce(new AwsBusinessApiError(503, undefined, "x"));
        const dispatcher = createShootTaskDispatcher(api as never, c as never, store);
        await dispatcher.runOnce();
        await dispatcher.runOnce();
        await dispatcher.runOnce();
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
        expect(c.markShootTaskDelivered).toHaveBeenLastCalledWith(item.publicId, 501);
        expect(store.open.size).toBe(0);
    });

    it("a lost «delivered» is retried from the store even after the row left pending (superseded)", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 501 }), editMessageText: vi.fn() };
        const store = memoryStore();
        const c = client([item]);
        c.markShootTaskDelivered.mockRejectedValueOnce(new AwsBusinessApiError(502, undefined, "x"));
        const dispatcher = createShootTaskDispatcher(api as never, c as never, store);
        await dispatcher.runOnce();
        expect(store.open.has(item.publicId)).toBe(true);
        c.pendingShootTasks.mockResolvedValue({ items: [], invalidPublicIds: [], unidentifiableCount: 0 });
        await dispatcher.runOnce();
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
        expect(c.markShootTaskDelivered).toHaveBeenCalledTimes(2);
        expect(c.markShootTaskDelivered).toHaveBeenLastCalledWith(item.publicId, 501);
        expect(store.open.size).toBe(0);
    });

    it("a 4xx on «delivered» is final: the retry list drops the row", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 501 }), editMessageText: vi.fn() };
        const store = memoryStore();
        const c = client([item]);
        c.markShootTaskDelivered.mockRejectedValueOnce(new AwsBusinessApiError(404, "SHOOT_TASK_NOT_FOUND", "x"));
        await createShootTaskDispatcher(api as never, c as never, store).runOnce();
        expect(store.open.size).toBe(0);
    });

    it("a retry entry whose sent key expired is dropped without a call", async () => {
        const store = memoryStore();
        store.open.add("6f1c0000-0000-4000-8000-000000000009");
        const c = client([]);
        await createShootTaskDispatcher({ sendMessage: vi.fn(), editMessageText: vi.fn() } as never, c as never, store).runOnce();
        expect(c.markShootTaskDelivered).not.toHaveBeenCalled();
        expect(store.open.size).toBe(0);
    });

    it("TG_403 is reported as such, and nothing of the payload reaches the log", async () => {
        const blocked = tgError(403, "Forbidden: bot was blocked by the user", "sendMessage");
        const api = { sendMessage: vi.fn().mockRejectedValue(blocked), editMessageText: vi.fn() };
        const c = client([item]);
        await createShootTaskDispatcher(api as never, c as never, memoryStore()).runOnce();
        expect(c.markShootTaskFailed).toHaveBeenCalledWith(item.publicId, "TG_403");
        expect(logBusinessEvent).toHaveBeenCalledWith(expect.objectContaining({ safeContext: { kind: "ASSIGNED", publicId: item.publicId, status: "TG_403" } }));
        expect(JSON.stringify(logBusinessEvent.mock.calls)).not.toMatch(/380|Олена|Dragon/u);
    });

    it("REDACT edits the target message and removes its buttons", async () => {
        const api = { sendMessage: vi.fn(), editMessageText: vi.fn().mockResolvedValue(true) };
        const c = client([redact]);
        await createShootTaskDispatcher(api as never, c as never, memoryStore()).runOnce();
        expect(api.editMessageText).toHaveBeenCalledWith(1164289764, 777, expect.stringContaining("Клієнт: Олена · телефон приховано."), expect.objectContaining({ reply_markup: { inline_keyboard: [] } }));
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(c.markShootTaskDelivered).toHaveBeenCalledWith(item.publicId, 777);
    });

    it.each([
        ["Bad Request: message is not modified: specified new message content and reply markup are exactly the same", "TG_NOT_MODIFIED"],
        ["Bad Request: MESSAGE IS NOT MODIFIED", "TG_NOT_MODIFIED"],
        ["Bad Request: message to edit not found", "TG_MESSAGE_GONE"],
        ["Bad Request: Message to edit not found", "TG_MESSAGE_GONE"],
        ["Bad Request: MESSAGE_ID_INVALID", "TG_MESSAGE_GONE"],
    ])("REDACT refused with «%s» is reported as %s", async (description, reason) => {
        const api = { sendMessage: vi.fn(), editMessageText: vi.fn().mockRejectedValue(tgError(400, description)) };
        const c = client([redact]);
        await createShootTaskDispatcher(api as never, c as never, memoryStore()).runOnce();
        expect(c.markShootTaskFailed).toHaveBeenCalledWith(item.publicId, reason);
        expect(c.markShootTaskDelivered).not.toHaveBeenCalled();
    });

    it("other edit refusals stay a plain Telegram code", async () => {
        const api = { sendMessage: vi.fn(), editMessageText: vi.fn().mockRejectedValue(tgError(400, "Bad Request: message can't be edited")) };
        const c = client([redact]);
        await createShootTaskDispatcher(api as never, c as never, memoryStore()).runOnce();
        expect(c.markShootTaskFailed).toHaveBeenCalledWith(item.publicId, "TG_400");
    });

    it("«not modified» on a plain send is not mistaken for a closed REDACT", async () => {
        const api = { sendMessage: vi.fn().mockRejectedValue(tgError(400, "Bad Request: message is not modified", "sendMessage")), editMessageText: vi.fn() };
        const c = client([item]);
        await createShootTaskDispatcher(api as never, c as never, memoryStore()).runOnce();
        expect(c.markShootTaskFailed).toHaveBeenCalledWith(item.publicId, "TG_400");
    });

    it("REDACT without a target message is failed, not sent", async () => {
        const api = { sendMessage: vi.fn(), editMessageText: vi.fn() };
        const c = client([{ ...redact, targetMessageId: null }]);
        await createShootTaskDispatcher(api as never, c as never, memoryStore()).runOnce();
        expect(api.editMessageText).not.toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(c.markShootTaskFailed).toHaveBeenCalledWith(item.publicId, "SHOOT_TASK_NO_TARGET");
    });

    it("marks rows that failed validation as failed and counts the unidentifiable ones", async () => {
        const c = client([], ["bad-1"], 2);
        await createShootTaskDispatcher({ sendMessage: vi.fn(), editMessageText: vi.fn() } as never, c as never, memoryStore()).runOnce();
        expect(c.markShootTaskFailed).toHaveBeenCalledWith("bad-1", "SHOOT_TASK_PAYLOAD_INVALID");
        expect(logBusinessEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "bot.shoot_tasks.unidentifiable", safeContext: { count: 2 } }));
    });

    it("sends nothing while the dedupe store is unreachable", async () => {
        const api = { sendMessage: vi.fn(), editMessageText: vi.fn() };
        const store = { ...memoryStore(), get: vi.fn().mockRejectedValue(new Error("redis down")) };
        await createShootTaskDispatcher(api as never, client([item]) as never, store).runOnce();
        expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("a broken retry list does not stop new rows", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 501 }), editMessageText: vi.fn() };
        const store = { ...memoryStore(), unconfirmed: vi.fn().mockRejectedValue(new Error("redis down")) };
        await createShootTaskDispatcher(api as never, client([item]) as never, store).runOnce();
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["Telegram 429", () => tgError(429, "Too Many Requests: retry after 5", "sendMessage")],
        ["Telegram 502", () => tgError(502, "Bad Gateway", "sendMessage")],
    ])("%s leaves the row PENDING: no failed, only a log", async (_name, make) => {
        const api = { sendMessage: vi.fn().mockRejectedValue(make()), editMessageText: vi.fn() };
        const c = client([item]);
        await createShootTaskDispatcher(api as never, c as never, memoryStore()).runOnce();
        expect(c.markShootTaskFailed).not.toHaveBeenCalled();
        expect(c.markShootTaskDelivered).not.toHaveBeenCalled();
        expect(logBusinessEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "bot.shoot_tasks.send_deferred" }));
    });

    it("a network failure (HttpError) leaves the row PENDING too", async () => {
        const api = { sendMessage: vi.fn().mockRejectedValue(new HttpError("Network request for 'sendMessage' failed!", new Error("ECONNRESET"))), editMessageText: vi.fn() };
        const c = client([item]);
        await createShootTaskDispatcher(api as never, c as never, memoryStore()).runOnce();
        expect(c.markShootTaskFailed).not.toHaveBeenCalled();
        expect(logBusinessEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "bot.shoot_tasks.send_deferred", safeContext: expect.objectContaining({ status: "HTTP_ERROR" }) }));
    });

    it("Redis refused the pair: the row that comes back is not sent again (in-process fallback)", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 501 }), editMessageText: vi.fn() };
        const store = memoryStore();
        store.remember.mockRejectedValueOnce(new Error("redis down")).mockRejectedValueOnce(new Error("redis down"));
        const c = client([item]);
        c.markShootTaskDelivered.mockRejectedValueOnce(new Error("api down"));
        const dispatcher = createShootTaskDispatcher(api as never, c as never, store);
        await dispatcher.runOnce();
        await dispatcher.runOnce();
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
        expect(store.map.has(item.publicId)).toBe(false);
        await dispatcher.runOnce();
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
        expect(store.map.get(item.publicId)).toBe(501);
        expect(c.markShootTaskDelivered).toHaveBeenLastCalledWith(item.publicId, 501);
    });

    it("the fallback entry is retried even after the row left pending, and dropped once Redis and the webapp have it", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 501 }), editMessageText: vi.fn() };
        const store = memoryStore();
        store.remember.mockRejectedValueOnce(new Error("redis down"));
        const c = client([item]);
        c.markShootTaskDelivered.mockRejectedValueOnce(new Error("api down"));
        const dispatcher = createShootTaskDispatcher(api as never, c as never, store);
        await dispatcher.runOnce();
        c.pendingShootTasks.mockResolvedValue({ items: [], invalidPublicIds: [], unidentifiableCount: 0 });
        await dispatcher.runOnce();
        expect(store.map.get(item.publicId)).toBe(501);
        expect(c.markShootTaskDelivered).toHaveBeenLastCalledWith(item.publicId, 501);
        const calls = c.markShootTaskDelivered.mock.calls.length;
        await dispatcher.runOnce();
        expect(c.markShootTaskDelivered).toHaveBeenCalledTimes(calls);
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("a fallback entry whose «delivered» got a final 4xx is not retried every minute", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 501 }), editMessageText: vi.fn() };
        const store = memoryStore();
        store.remember.mockRejectedValue(new Error("redis down"));
        const c = client([item]);
        c.markShootTaskDelivered.mockRejectedValue(new AwsBusinessApiError(404, "SHOOT_TASK_NOT_FOUND", "x"));
        const dispatcher = createShootTaskDispatcher(api as never, c as never, store);
        await dispatcher.runOnce();
        await dispatcher.runOnce();
        await dispatcher.runOnce();
        expect(c.markShootTaskDelivered).toHaveBeenCalledTimes(1);
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });
});

describe("startPolling", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("skips a tick while a poll runs, and stop() waits for the poll in flight", async () => {
        vi.useFakeTimers();
        let finish!: () => void;
        const runOnce = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
        const poller = startPolling(runOnce, 1000, vi.fn());
        await vi.advanceTimersByTimeAsync(2500);
        expect(runOnce).toHaveBeenCalledTimes(1);
        let stopped = false;
        const stopping = poller.stop(10_000).then((settled) => {
            stopped = settled;
        });
        await vi.advanceTimersByTimeAsync(10);
        expect(stopped).toBe(false);
        finish();
        await stopping;
        expect(stopped).toBe(true);
        await vi.advanceTimersByTimeAsync(5000);
        expect(runOnce).toHaveBeenCalledTimes(1);
    });

    it("stop() gives up after the timeout", async () => {
        vi.useFakeTimers();
        const poller = startPolling(() => new Promise<void>(() => {}), 1000, vi.fn());
        await vi.advanceTimersByTimeAsync(1000);
        const stopping = poller.stop(10_000);
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(stopping).resolves.toBe(false);
    });

    it("stop() with nothing in flight resolves at once", async () => {
        const poller = startPolling(vi.fn().mockResolvedValue(undefined), 60_000, vi.fn());
        await expect(poller.stop(10_000)).resolves.toBe(true);
    });
});

describe("redisSentStore", () => {
    beforeEach(() => {
        for (const fn of Object.values(redis)) fn.mockReset().mockResolvedValue(null);
    });

    function multi(result: unknown) {
        const chain = { set: vi.fn(), sadd: vi.fn(), exec: vi.fn().mockResolvedValue(result) };
        chain.set.mockReturnValue(chain);
        chain.sadd.mockReturnValue(chain);
        redis.multi.mockReturnValue(chain);
        return chain;
    }

    it("keeps the message id for 7 days under shoot-task:sent:<publicId> and lists it until confirmed — in one MULTI", async () => {
        const chain = multi([[null, "OK"], [null, 1]]);
        await redisSentStore.remember(item.publicId, 501);
        expect(chain.set).toHaveBeenCalledWith(`shoot-task:sent:${item.publicId}`, "501", "EX", 7 * 24 * 60 * 60);
        expect(chain.sadd).toHaveBeenCalledWith("shoot-task:unconfirmed", item.publicId);
        expect(chain.exec).toHaveBeenCalledTimes(1);
        await redisSentStore.confirmed(item.publicId);
        expect(redis.srem).toHaveBeenCalledWith("shoot-task:unconfirmed", item.publicId);
    });

    it.each([
        ["a failed command", [[null, "OK"], [new Error("OOM"), null]]],
        ["an aborted transaction", null],
    ])("remember throws on %s", async (_name, result) => {
        multi(result);
        await expect(redisSentStore.remember(item.publicId, 501)).rejects.toThrow();
    });

    it("reads the message id back as a number, and null when absent or garbled", async () => {
        redis.get.mockResolvedValueOnce("501").mockResolvedValueOnce(null).mockResolvedValueOnce("abc");
        expect(await redisSentStore.get(item.publicId)).toBe(501);
        expect(await redisSentStore.get(item.publicId)).toBeNull();
        expect(await redisSentStore.get(item.publicId)).toBeNull();
    });
});
