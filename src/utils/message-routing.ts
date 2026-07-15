import type { Chat } from "grammy/types";

/** Candidate, staff, and admin role flows are private-chat interfaces. */
export function shouldRouteMessageToPrivateRoleFlows(chatType?: Chat["type"]): boolean {
    return chatType === "private";
}
