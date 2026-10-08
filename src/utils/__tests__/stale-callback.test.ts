import { describe, expect, it } from "vitest";
import { isKnownCallback, shouldShieldStaleCallback } from "../stale-callback.js";

describe("захист від застарілих кнопок", () => {
    it("кнопки постійної теми — відомі", () => {
        expect(isKnownCallback("sth:c:t1:k")).toBe(true);
        expect(isKnownCallback("sth:b:t1")).toBe(true);
    });

    it("старі відомі префікси лишаються відомими", () => {
        for (const data of ["staff_hub_nav", "ticket_close_5", "cb:sds:1", "broadcast_confirm_decline_3", "a/b"]) {
            expect(isKnownCallback(data)).toBe(true);
        }
    });

    it("невідома кнопка в приватному чаті — під захист", () => {
        expect(shouldShieldStaleCallback("old_thing_1", "private")).toBe(true);
    });

    it("у групі захист не чіпає нічого — він видалив би чуже повідомлення", () => {
        expect(shouldShieldStaleCallback("old_thing_1", "supergroup")).toBe(false);
    });
});
