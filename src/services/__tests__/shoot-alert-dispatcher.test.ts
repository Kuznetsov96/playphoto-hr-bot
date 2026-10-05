import { describe, expect, it, vi } from "vitest";
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
});
