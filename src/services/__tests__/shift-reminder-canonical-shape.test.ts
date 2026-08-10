import { describe, expect, it } from "vitest";

// Guards the contract the delivery loop depends on: whatever the canonical path
// returns must expose staff.user.telegramId exactly like the legacy repository does.
function attachStaff(
    shifts: Array<{ staffId: string; id: string }>,
    profiles: Array<{ id: string; fullName: string; user: { telegramId: bigint } }>
) {
    const byId = new Map(profiles.map(profile => [profile.id, profile]));
    return shifts.flatMap(shift => {
        const profile = byId.get(shift.staffId);
        return profile ? [{ ...shift, staff: profile }] : [];
    });
}

describe("canonical reminder shift shape", () => {
    it("exposes staff.user.telegramId the delivery loop reads", () => {
        const result = attachStaff(
            [{ staffId: "staff-1", id: "shift-1" }],
            [{ id: "staff-1", fullName: "Іваненко Олена", user: { telegramId: 12345n } }]
        );
        expect(result[0]!.staff.user.telegramId).toBe(12345n);
    });

    it("drops a shift whose staff profile is missing rather than emitting a broken record", () => {
        expect(attachStaff([{ staffId: "ghost", id: "shift-1" }], [])).toEqual([]);
    });
});
