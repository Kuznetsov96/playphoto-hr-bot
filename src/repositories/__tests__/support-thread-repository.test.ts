import { beforeEach, describe, expect, it, vi } from "vitest";

const db = {
    supportThread: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    supportMessageLink: { createMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
    supportTicket: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    outgoingTopic: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    taskProofSubmission: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    staffProfile: { findMany: vi.fn() },
};

vi.mock("../../db/core.js", () => ({ default: db }));

const { supportThreadRepository } = await import("../support-thread-repository.js");

beforeEach(() => {
    vi.clearAllMocks();
    db.supportTicket.findFirst.mockResolvedValue(null);
    db.outgoingTopic.findFirst.mockResolvedValue(null);
    db.taskProofSubmission.findFirst.mockResolvedValue(null);
    db.supportTicket.findMany.mockResolvedValue([]);
    db.outgoingTopic.findMany.mockResolvedValue([]);
    db.taskProofSubmission.findMany.mockResolvedValue([]);
});

describe("зв'язки повідомлень", () => {
    /** Повторна обробка того самого оновлення не має падати на унікальному індексі. */
    it("додає зв'язок із пропуском дубля", async () => {
        await supportThreadRepository.addLink({ threadId: "t1", direction: "IN", topicChatId: -100n, topicMessageId: 5, privateChatId: 7n, privateMessageId: 9 });
        expect(db.supportMessageLink.createMany).toHaveBeenCalledWith({
            data: [expect.objectContaining({ threadId: "t1", direction: "IN", topicMessageId: 5, privateMessageId: 9 })],
            skipDuplicates: true,
        });
    });

    it("шукає пару за повідомленням у темі", async () => {
        db.supportMessageLink.findUnique.mockResolvedValue({ id: 1 });
        await supportThreadRepository.findLinkByTopicMessage(-100n, 5);
        expect(db.supportMessageLink.findUnique).toHaveBeenCalledWith({
            where: { topicChatId_topicMessageId: { topicChatId: -100n, topicMessageId: 5 } },
            include: { thread: true },
        });
    });
});

describe("стара тема", () => {
    it("впізнає людину за тікетом незалежно від статусу", async () => {
        db.supportTicket.findFirst.mockResolvedValue({ userId: "u-ticket" });
        await expect(supportThreadRepository.findLegacyUserByTopic(-100n, 42)).resolves.toBe("u-ticket");
        expect(db.supportTicket.findFirst.mock.calls[0]![0].where).toEqual({ topicId: 42 });
    });

    it("далі вихідна тема, потім тема задачі", async () => {
        db.taskProofSubmission.findFirst.mockResolvedValue({ staff: { userId: "u-proof" } });
        await expect(supportThreadRepository.findLegacyUserByTopic(-100n, 42)).resolves.toBe("u-proof");
        expect(db.outgoingTopic.findFirst).toHaveBeenCalled();
    });

    it("не впізнана тема — null", async () => {
        await expect(supportThreadRepository.findLegacyUserByTopic(-100n, 42)).resolves.toBeNull();
    });

    it("групує активні старі розмови за людиною", async () => {
        db.supportTicket.findMany.mockResolvedValue([{ id: 1, userId: "u1", topicId: 10, status: "OPEN" }, { id: 2, userId: "u1", topicId: null, status: "IN_PROGRESS" }]);
        db.outgoingTopic.findMany.mockResolvedValue([{ id: 3, userId: "u1", topicId: 11, chatId: -100n }, { id: 4, userId: null, topicId: 12, chatId: -100n }]);
        db.taskProofSubmission.findMany.mockResolvedValue([{ id: "p1", supportTopicId: 13, supportChatId: -100n, supportTopicStatus: "WAITING_FOR_STAFF", staff: { userId: "u2" } }]);
        const rows = await supportThreadRepository.listLegacyActive(-100n);
        expect(rows).toEqual([
            { userId: "u1", topics: [{ chatId: -100n, topicId: 10 }, { chatId: -100n, topicId: 11 }], ticketIds: [1, 2], outgoingIds: [3], proofIds: [], waiting: true },
            { userId: "u2", topics: [{ chatId: -100n, topicId: 13 }], ticketIds: [], outgoingIds: [], proofIds: ["p1"], waiting: false },
        ]);
    });
});

describe("збіг прізвищ", () => {
    it("повертає прізвища, що повторюються серед активних і тих, у кого є тема", async () => {
        db.staffProfile.findMany.mockResolvedValue([
            { fullName: "Іванова Анна" },
            { fullName: "Іванова Олена" },
            { fullName: "Бланк Анастасія" },
        ]);
        const result = await supportThreadRepository.listCollidingSurnames();
        expect([...result]).toEqual(["Іванова"]);
        expect(db.staffProfile.findMany.mock.calls[0]![0].where).toEqual({ OR: [{ isActive: true }, { user: { supportThread: { isNot: null } } }] });
    });
});
