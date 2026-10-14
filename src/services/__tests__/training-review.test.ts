import { describe, expect, it } from "vitest";
import {
    buildMiniAppUrl,
    parsePitchReviewPayload,
    readCandidateMessage,
    readTrainingMode,
} from "../training-review.js";

describe("training payload readers", () => {
    it("treats a missing payload as the owner contour", () => {
        expect(readTrainingMode(null)).toBe("OWNER");
        expect(readTrainingMode({})).toBe("OWNER");
        expect(readTrainingMode({ trainingMode: "MINIAPP" })).toBe("MINIAPP");
        expect(readTrainingMode({ trainingMode: "SOMETHING_NEW" })).toBe("OWNER");
    });

    it("reads the rejection text marker only when it is known", () => {
        expect(readCandidateMessage(null)).toBeNull();
        expect(readCandidateMessage({ candidateMessage: "TRAINING_REJECTED" })).toBe("TRAINING_REJECTED");
        expect(readCandidateMessage({ candidateMessage: "OTHER" })).toBeNull();
    });

    it("parses a pitch review payload", () => {
        const parsed = parsePitchReviewPayload({
            reviewPublicId: "5b0c3f5e-9a51-4c2b-9b7a-0c1f3e8d2a11",
            fileId: "AwACAgIAAxkBAAIB",
            attachmentKind: "VOICE",
            candidateName: "Марія Коваль",
            locationName: "Drive City",
            scorePct: 86,
            attemptNo: 2,
            checklist: ["Привітання", "Фото", "Магніти", "Набір", "Дорого", "Допродаж"],
            reminder: false,
        });
        expect(parsed.attemptNo).toBe(2);
        expect(parsed.checklist).toHaveLength(6);
    });

    it("rejects a pitch review payload without a file", () => {
        expect(() => parsePitchReviewPayload({ reviewPublicId: "x" })).toThrow();
    });

    it("builds the Mini App url and refuses a missing base", () => {
        expect(buildMiniAppUrl("https://app.playphoto.com.ua/", "/learn")).toBe("https://app.playphoto.com.ua/learn");
        expect(() => buildMiniAppUrl(undefined, "/learn")).toThrow("OFFER_NOT_SENT:miniapp_url_missing");
    });

    it("joins a path without a leading slash with exactly one slash", () => {
        expect(buildMiniAppUrl("https://app.playphoto.com.ua", "learn")).toBe("https://app.playphoto.com.ua/learn");
        expect(buildMiniAppUrl("https://app.playphoto.com.ua/", "learn")).toBe("https://app.playphoto.com.ua/learn");
    });
});
