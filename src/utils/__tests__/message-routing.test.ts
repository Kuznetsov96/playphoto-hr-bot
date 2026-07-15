import { describe, expect, it } from "vitest";
import { shouldRouteMessageToPrivateRoleFlows } from "../message-routing.js";

describe("shouldRouteMessageToPrivateRoleFlows", () => {
    it("routes only private chat messages into role flows", () => {
        expect(shouldRouteMessageToPrivateRoleFlows("private")).toBe(true);
        expect(shouldRouteMessageToPrivateRoleFlows("group")).toBe(false);
        expect(shouldRouteMessageToPrivateRoleFlows("supergroup")).toBe(false);
        expect(shouldRouteMessageToPrivateRoleFlows("channel")).toBe(false);
        expect(shouldRouteMessageToPrivateRoleFlows(undefined)).toBe(false);
    });
});
