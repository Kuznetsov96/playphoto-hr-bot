import { describe, expect, it } from "vitest";
import { extractBulkTaskMedia } from "../task-bulk.js";

/**
 * Divergence D з аудиту вирівнювання майстрів постановки задач: bulk-флоу
 * раніше розпізнавав лише photo і document, тоді як task-creation.ts і
 * task-flow.ts приймали всі 7 типів з `TaskAttachmentItem["type"]`
 * (src/types/context.ts:28). Адмін, що прикріпив voice/video/video_note/
 * audio/animation до масового завдання, втрачав вкладення без попередження.
 */
describe("extractBulkTaskMedia", () => {
    it("extracts the last (highest resolution) photo", () => {
        const media = extractBulkTaskMedia({
            photo: [{ file_id: "small" }, { file_id: "large" }],
        });
        expect(media).toEqual({ fileId: "large", mediaType: "photo" });
    });

    it("extracts a document", () => {
        expect(extractBulkTaskMedia({ document: { file_id: "doc1" } }))
            .toEqual({ fileId: "doc1", mediaType: "document" });
    });

    it("extracts a video", () => {
        expect(extractBulkTaskMedia({ video: { file_id: "vid1" } }))
            .toEqual({ fileId: "vid1", mediaType: "video" });
    });

    it("extracts a voice message", () => {
        expect(extractBulkTaskMedia({ voice: { file_id: "voice1" } }))
            .toEqual({ fileId: "voice1", mediaType: "voice" });
    });

    it("extracts a video note (circle video)", () => {
        expect(extractBulkTaskMedia({ video_note: { file_id: "note1" } }))
            .toEqual({ fileId: "note1", mediaType: "video_note" });
    });

    it("extracts an audio file", () => {
        expect(extractBulkTaskMedia({ audio: { file_id: "audio1" } }))
            .toEqual({ fileId: "audio1", mediaType: "audio" });
    });

    it("extracts an animation (GIF)", () => {
        expect(extractBulkTaskMedia({ animation: { file_id: "gif1" } }))
            .toEqual({ fileId: "gif1", mediaType: "animation" });
    });

    it("returns null when no supported media is present", () => {
        expect(extractBulkTaskMedia({})).toBeNull();
    });
});
