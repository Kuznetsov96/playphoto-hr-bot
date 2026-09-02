import { describe, expect, it } from "vitest";
import { buildCandidateMirrorSnapshot } from "../snapshot.js";

/**
 * Строитель снимка — чистая функция: строка кандидата с релейшенами на входе,
 * wire-объект для POST /internal/bot/recruiting/candidates на выходе. Прёмная
 * сторона (вебапп) валидирует class-validator'ом: каждая дата обязана быть
 * строгой ISO-строкой или null, telegramId — строкой из цифр.
 */
function buildRow(overrides: Record<string, unknown> = {}) {
    return {
        id: "cand-1",
        fullName: "Олена Тест",
        phone: "+380671234567",
        gender: "female",
        birthDate: new Date("2001-05-15T00:00:00.000Z"),
        city: "Київ",
        source: "olx",
        status: "INTERVIEW_SCHEDULED",
        hrDecision: null,
        lossStage: null,
        lossReason: null,
        statusChangedAt: new Date("2026-08-20T10:00:00.000Z"),
        pipelineTouchedAt: new Date("2026-08-21T09:30:00.000Z"),
        user: {
            telegramId: 1164289764n,
            username: "olena_test",
            createdAt: new Date("2026-08-01T08:00:00.000Z"),
        },
        location: { canonicalCode: "fantasy-town-cherkasy" },
        interviewSlot: { startTime: new Date("2026-08-28T14:00:00.000Z") },
        ...overrides,
    };
}

describe("buildCandidateMirrorSnapshot", () => {
    it("maps every field of a fully populated candidate", () => {
        const snapshot = buildCandidateMirrorSnapshot(buildRow() as never);

        expect(snapshot).toEqual({
            telegramId: "1164289764",
            botCandidateId: "cand-1",
            telegramUsername: "olena_test",
            fullName: "Олена Тест",
            phone: "+380671234567",
            gender: "female",
            birthDate: "2001-05-15",
            city: "Київ",
            locationCode: "fantasy-town-cherkasy",
            source: "olx",
            botStatus: "INTERVIEW_SCHEDULED",
            hrDecision: null,
            lossStage: null,
            lossReason: null,
            interviewAt: "2026-08-28T14:00:00.000Z",
            statusChangedAt: "2026-08-20T10:00:00.000Z",
            lastActivityAt: "2026-08-21T09:30:00.000Z",
            botCreatedAt: "2026-08-01T08:00:00.000Z",
            tattooPhotoFileId: null,
        });
    });

    it("serialises telegramId as a digits-only string, never a BigInt", () => {
        const snapshot = buildCandidateMirrorSnapshot(buildRow() as never);
        expect(typeof snapshot.telegramId).toBe("string");
        expect(snapshot.telegramId).toMatch(/^\d+$/u);
        // Снимок обязан переживать JSON.stringify — BigInt в нём кидает TypeError.
        expect(() => JSON.stringify(snapshot)).not.toThrow();
    });

    it("converts a legacy 'DD.MM.YYYY' birth date string to ISO 'YYYY-MM-DD'", () => {
        const snapshot = buildCandidateMirrorSnapshot(
            buildRow({ birthDate: "15.05.1998" }) as never
        );
        expect(snapshot.birthDate).toBe("1998-05-15");
    });

    it("sends null for an unparseable birth date instead of failing", () => {
        for (const bad of ["не скажу", "31.02.2000", "1998-15-05-junk", "", new Date("invalid")]) {
            const snapshot = buildCandidateMirrorSnapshot(buildRow({ birthDate: bad }) as never);
            expect(snapshot.birthDate).toBeNull();
        }
    });

    it("normalises gender: only 'female'/'male' pass through, anything else becomes null", () => {
        expect(buildCandidateMirrorSnapshot(buildRow({ gender: "male" }) as never).gender).toBe("male");
        expect(buildCandidateMirrorSnapshot(buildRow({ gender: "дівчина" }) as never).gender).toBeNull();
        expect(buildCandidateMirrorSnapshot(buildRow({ gender: null }) as never).gender).toBeNull();
    });

    it("degrades missing relations and empty fields to nulls, not crashes", () => {
        const snapshot = buildCandidateMirrorSnapshot(buildRow({
            fullName: null,
            phone: null,
            gender: null,
            birthDate: null,
            city: null,
            source: null,
            hrDecision: null,
            lossStage: null,
            lossReason: null,
            statusChangedAt: null,
            location: null,
            interviewSlot: null,
            tattooPhotoId: null,
            user: { telegramId: 42n, username: null, createdAt: null },
        }) as never);

        expect(snapshot).toEqual({
            telegramId: "42",
            botCandidateId: "cand-1",
            telegramUsername: null,
            fullName: null,
            phone: null,
            gender: null,
            birthDate: null,
            city: null,
            locationCode: null,
            source: null,
            botStatus: "INTERVIEW_SCHEDULED",
            hrDecision: null,
            lossStage: null,
            lossReason: null,
            interviewAt: null,
            statusChangedAt: null,
            lastActivityAt: expect.any(String),
            botCreatedAt: null,
            tattooPhotoFileId: null,
        });
    });

    it("passes the raw bot status through untouched — the webapp tolerates unknown values", () => {
        const snapshot = buildCandidateMirrorSnapshot(
            buildRow({ status: "SOME_FUTURE_STATUS" }) as never
        );
        expect(snapshot.botStatus).toBe("SOME_FUTURE_STATUS");
    });

    it("mirrors loss tracking for a rejected candidate", () => {
        const snapshot = buildCandidateMirrorSnapshot(buildRow({
            status: "REJECTED",
            hrDecision: "NOSHOW",
            lossStage: "INTERVIEW",
            lossReason: "INTERVIEW_NO_SHOW",
        }) as never);

        expect(snapshot.botStatus).toBe("REJECTED");
        expect(snapshot.hrDecision).toBe("NOSHOW");
        expect(snapshot.lossStage).toBe("INTERVIEW");
        expect(snapshot.lossReason).toBe("INTERVIEW_NO_SHOW");
    });

    it("переносит file_id фото тату в снимок", () => {
        const snapshot = buildCandidateMirrorSnapshot(buildRow({
            tattooPhotoId: "AgACAgIAAxkBAAI",
        }) as never);

        expect(snapshot.tattooPhotoFileId).toBe("AgACAgIAAxkBAAI");
    });

    it("без фото шлёт null, а не пустую строку", () => {
        const snapshot = buildCandidateMirrorSnapshot(buildRow({
            tattooPhotoId: null,
        }) as never);

        expect(snapshot.tattooPhotoFileId).toBeNull();
    });
});
