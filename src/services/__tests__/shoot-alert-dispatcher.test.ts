import { describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";
import { shootAlertSchema } from "../aws-business-client.js";
import { createShootAlertDispatcher } from "../shoot-alert-dispatcher.js";

const alert = {
    publicId: "6f1c0000-0000-4000-8000-000000000001",
    kind: "DAILY_DIGEST" as const,
    payload: {
        openUrl: "https://app.example/owner/shoots",
        items: [
            { shootPublicId: "a", locationName: "Dragon Park <1>", shootOn: "2030-03-10", startsAtLocalTime: "12:00", childName: "Марта" },
            { shootPublicId: "b", locationName: "Leoland", shootOn: "2030-03-11", startsAtLocalTime: null, childName: null },
        ],
    },
};

function fakeClient(items: unknown[], invalidPublicIds: string[] = []) {
    return {
        pendingShootAlerts: vi.fn().mockResolvedValue({ items, invalidPublicIds, unidentifiableCount: 0 }),
        markShootAlertDelivered: vi.fn().mockResolvedValue(undefined),
        markShootAlertFailed: vi.fn().mockResolvedValue(undefined),
    };
}

describe("ShootAlertDispatcher", () => {
    it("sends the digest to the first admin and marks it delivered", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({}) };
        const client = fakeClient([alert]);
        await createShootAlertDispatcher(api as never, client as never, [111, 222]).runOnce();
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
        expect(api.sendMessage).toHaveBeenCalledWith(
            111,
            expect.stringContaining("10.03 12:00 · Dragon Park &lt;1&gt; · Марта"),
            expect.objectContaining({ parse_mode: "HTML" }),
        );
        expect(client.markShootAlertDelivered).toHaveBeenCalledWith(alert.publicId);
    });

    it("reports failure when no admin is configured", async () => {
        const client = fakeClient([alert]);
        await createShootAlertDispatcher({ sendMessage: vi.fn() } as never, client as never, []).runOnce();
        expect(client.markShootAlertFailed).toHaveBeenCalledWith(alert.publicId, "SHOOT_ALERT_NO_ADMIN_CONFIGURED");
    });

    it("reports a Telegram error without leaking payload text", async () => {
        const api = { sendMessage: vi.fn().mockRejectedValue(new Error("Forbidden: bot was blocked")) };
        const client = fakeClient([alert]);
        await createShootAlertDispatcher(api as never, client as never, [111]).runOnce();
        const [, reason] = client.markShootAlertFailed.mock.calls[0]!;
        expect(reason).not.toContain("Марта");
        expect(client.markShootAlertDelivered).not.toHaveBeenCalled();
    });

    it("marks rows that failed validation as failed", async () => {
        const client = fakeClient([], ["bad-1"]);
        await createShootAlertDispatcher({ sendMessage: vi.fn() } as never, client as never, [111]).runOnce();
        expect(client.markShootAlertFailed).toHaveBeenCalledWith("bad-1", "SHOOT_ALERT_PAYLOAD_INVALID");
    });

    const second = { ...alert, publicId: "6f1c0000-0000-4000-8000-000000000002" };

    it("does not mark failed when markDelivered rejects, and continues the batch", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({}) };
        const client = fakeClient([alert, second]);
        client.markShootAlertDelivered.mockRejectedValueOnce(new Error("api down"));
        await createShootAlertDispatcher(api as never, client as never, [111]).runOnce();
        expect(client.markShootAlertFailed).not.toHaveBeenCalled();
        expect(api.sendMessage).toHaveBeenCalledTimes(2);
        expect(client.markShootAlertDelivered).toHaveBeenCalledWith(second.publicId);
    });

    it("keeps processing when markFailed rejects", async () => {
        const api = { sendMessage: vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue({}) };
        const client = fakeClient([alert, second]);
        client.markShootAlertFailed.mockRejectedValueOnce(new Error("api down"));
        await createShootAlertDispatcher(api as never, client as never, [111]).runOnce();
        expect(api.sendMessage).toHaveBeenCalledTimes(2);
        expect(client.markShootAlertDelivered).toHaveBeenCalledWith(second.publicId);
    });

    it("falls back to SEND_FAILED for an empty error message", async () => {
        const api = { sendMessage: vi.fn().mockRejectedValue(new Error("")) };
        const client = fakeClient([alert]);
        await createShootAlertDispatcher(api as never, client as never, [111]).runOnce();
        expect(client.markShootAlertFailed).toHaveBeenCalledWith(alert.publicId, "SEND_FAILED");
    });

    it("reports a GrammyError as TG_<code>", async () => {
        const err = new GrammyError("secret text", { ok: false, error_code: 403, description: "x" }, "sendMessage", {});
        const api = { sendMessage: vi.fn().mockRejectedValue(err) };
        const client = fakeClient([alert]);
        await createShootAlertDispatcher(api as never, client as never, [111]).runOnce();
        expect(client.markShootAlertFailed).toHaveBeenCalledWith(alert.publicId, "TG_403");
    });

    describe("payload schema", () => {
        const base = {
            publicId: "6f1c0000-0000-4000-8000-000000000001",
            kind: "DAILY_DIGEST",
            payload: {
                openUrl: "https://app.example/owner/shoots",
                items: [{
                    shootPublicId: "6f1c0000-0000-4000-8000-0000000000aa",
                    locationName: "L",
                    shootOn: "2030-03-10",
                    startsAtLocalTime: "12:00",
                    childName: null,
                }],
            },
        };
        const withItem = (patch: object) => ({ ...base, payload: { ...base.payload, items: [{ ...base.payload.items[0], ...patch }] } });
        const withUrl = (openUrl: string) => ({ ...base, payload: { ...base.payload, openUrl } });

        it("accepts a valid row", () => {
            expect(shootAlertSchema.safeParse(base).success).toBe(true);
        });
        it("rejects markup as time", () => {
            expect(shootAlertSchema.safeParse(withItem({ startsAtLocalTime: "<b>12:00</b>" })).success).toBe(false);
        });
        it.each(["http://x.example", "javascript:alert(1)"])("rejects openUrl %s", (u) => {
            expect(shootAlertSchema.safeParse(withUrl(u)).success).toBe(false);
        });
    });
});
