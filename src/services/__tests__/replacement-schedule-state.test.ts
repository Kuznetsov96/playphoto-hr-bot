import { describe, expect, it } from "vitest";
import { classifyAcceptedReplacement } from "../replacement-schedule-state.js";

const shiftDate = new Date("2030-05-12T00:00:00.000Z");
const assignment = {
    requesterStaffId: "original-staff",
    replacementStaffId: "replacement-staff",
    locationId: "location-1",
    shiftDate
};

describe("accepted replacement schedule state", () => {
    it("stays pending while the original photographer is still in the slot", () => {
        expect(classifyAcceptedReplacement(assignment, [{
            staffId: "original-staff",
            locationId: "location-1",
            date: shiftDate
        }])).toBe("pending");
    });

    it("is scheduled when the accepted photographer is in the requested slot", () => {
        expect(classifyAcceptedReplacement(assignment, [{
            staffId: "replacement-staff",
            locationId: "location-1",
            date: shiftDate
        }])).toBe("scheduled");
    });

    it("is superseded when a third photographer replaces the original owner", () => {
        expect(classifyAcceptedReplacement(assignment, [{
            staffId: "third-staff",
            locationId: "location-1",
            date: shiftDate
        }])).toBe("superseded");
    });

    it("is superseded when the accepted photographer is scheduled elsewhere that day", () => {
        expect(classifyAcceptedReplacement(assignment, [{
            staffId: "replacement-staff",
            locationId: "location-2",
            date: shiftDate
        }])).toBe("superseded");
    });
});
