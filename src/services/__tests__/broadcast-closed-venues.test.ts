import { describe, expect, it, vi } from "vitest";

vi.mock("../../repositories/location-repository.js", () => ({
    locationRepository: {
        findAll: vi.fn().mockResolvedValue([
            { id: "open", city: "Lviv", name: "Leoland", telegramChatId: "-1001", isHidden: false },
            { id: "closed", city: "Lviv", name: "Volkland", telegramChatId: "-1002", isHidden: true },
        ]),
        findById: vi.fn().mockResolvedValue(null),
    },
}));

vi.mock("../../repositories/staff-repository.js", () => ({
    staffRepository: { findActive: vi.fn().mockResolvedValue([]) },
}));

const { broadcastService } = await import("../broadcast.js");

// Закриту точку вебапп ховає, а її чат лишався в розсилці «по містах».
describe("city chat broadcast and closed venues", () => {
    it("skips the chat of a venue the web app has closed", async () => {
        const { chats } = await broadcastService.resolveTargets({ type: "city_chats", value: ["Lviv"] } as never);

        expect(chats).toContain(-1001);
        expect(chats).not.toContain(-1002);
    });

    it("still reaches a closed venue the admin picked explicitly", async () => {
        const { chats } = await broadcastService.resolveTargets({ type: "city_chat_location", value: ["closed"] } as never);

        expect(chats).toContain(-1002);
    });
});
