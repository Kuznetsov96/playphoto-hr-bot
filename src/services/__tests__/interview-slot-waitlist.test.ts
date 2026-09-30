import { describe, expect, it } from "vitest";
import { mergeFirstSeen, newestFirstSeen } from "../interview-slot-waitlist.js";

describe("interview slot first-seen tracking", () => {
    const earlier = new Date("2026-09-29T10:00:00.000Z");
    const now = new Date("2026-09-30T10:00:00.000Z");

    it("keeps the first sighting of a slot and stamps new ones with now", () => {
        const merged = mergeFirstSeen({ a: earlier.toISOString() }, ["a", "b"], now);

        expect(merged).toEqual({ a: earlier.toISOString(), b: now.toISOString() });
    });

    it("forgets slots that are no longer free", () => {
        expect(mergeFirstSeen({ gone: earlier.toISOString() }, [], now)).toEqual({});
    });

    it("the newest sighting decides who is notified", () => {
        expect(newestFirstSeen({ a: earlier.toISOString(), b: now.toISOString() })).toEqual(now);
        expect(newestFirstSeen({})).toBeNull();
    });
});
