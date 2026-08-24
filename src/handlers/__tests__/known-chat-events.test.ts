import { beforeEach, describe, expect, it, vi } from "vitest";

const recordPresent = vi.fn();
const recordLost = vi.fn();

vi.mock("../../repositories/known-chat-repository.js", () => ({
    knownChatRepository: { recordPresent, recordLost, listActive: vi.fn() },
}));

const { handleMyChatMember } = await import("../access.js");

beforeEach(() => vi.clearAllMocks());

describe("my_chat_member", () => {
    /**
     * This is the whole point of the registry: a new location's chat must appear without
     * anyone writing its id down. Adding the bot as administrator is the signal.
     */
    it("records a chat when the bot is made administrator", async () => {
        await handleMyChatMember({
            chat: { id: -100, title: "Fantasy Town", type: "supergroup" },
            new_chat_member: { status: "administrator" },
        } as never);

        expect(recordPresent).toHaveBeenCalledWith(
            expect.objectContaining({ id: -100n, title: "Fantasy Town" }),
        );
    });

    it("records a chat when the bot is added as a plain member", async () => {
        // Still worth knowing about — the reconciler will flag it as unusable, which is
        // visible, whereas not recording it at all is silent.
        await handleMyChatMember({
            chat: { id: -100, title: "Fantasy Town", type: "supergroup" },
            new_chat_member: { status: "member" },
        } as never);

        expect(recordPresent).toHaveBeenCalled();
    });

    it("marks the chat lost when the bot is removed", async () => {
        await handleMyChatMember({
            chat: { id: -100, title: "Fantasy Town", type: "supergroup" },
            new_chat_member: { status: "left" },
        } as never);

        expect(recordLost).toHaveBeenCalledWith(-100n);
        expect(recordPresent).not.toHaveBeenCalled();
    });

    it("marks the chat lost when the bot is kicked", async () => {
        await handleMyChatMember({
            chat: { id: -100, title: "Fantasy Town", type: "supergroup" },
            new_chat_member: { status: "kicked" },
        } as never);

        expect(recordLost).toHaveBeenCalledWith(-100n);
    });

    /** A private chat with one person is not a team chat and must never enter the registry. */
    it("ignores private chats", async () => {
        await handleMyChatMember({
            chat: { id: 12345, title: undefined, type: "private" },
            new_chat_member: { status: "member" },
        } as never);

        expect(recordPresent).not.toHaveBeenCalled();
        expect(recordLost).not.toHaveBeenCalled();
    });
});
