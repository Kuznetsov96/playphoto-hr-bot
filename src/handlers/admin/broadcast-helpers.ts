import { announcementLayout, visibleLength, type AnnouncementReplyMode, type Layout, type LayoutPart } from "../../services/announcement-layout.js";
import { isQuietHour } from "../../utils/quiet-hours.js";
import { PING_CONFIG } from "../../config.js";
import type { BroadcastMediaItem } from "../../types/context.js";

/** Лимиты создания рассылки: те же, что в вебапп-форме. */
export const MAX_MEDIA = 10;
export const MAX_DOCUMENTS = 10;
export const MAX_TEXT = 4096;

export const peopleLabel = (count: number): string => `${count} ${count === 1 ? "person" : "people"}`;

export const countMedia = (items: BroadcastMediaItem[]) => {
    const documents = items.filter(item => item.type === "document").length;
    return { media: items.length - documents, documents };
};

/** «Photos and videos: 3 of 10 · Files: 1 of 10» */
export const attachmentCounters = (items: BroadcastMediaItem[]): string => {
    const { media, documents } = countMedia(items);
    return `Photos and videos: ${media} of ${MAX_MEDIA} · Files: ${documents} of ${MAX_DOCUMENTS}`;
};

/** Слова вебаппа (messages/owner.en.ts → announcements.compose): «Arrives as 3 messages: album, file, then the text with reply buttons.» */
const ARRIVAL = {
    one: "Arrives as 1 message.",
    many: (n: number, parts: string) => `Arrives as ${n} messages: ${parts}.`,
    then: "then",
    album: "album",
    photo: "photo",
    video: "video",
    file: "file",
    files: "files",
    textButtons: "the text with reply buttons",
    text: "the text",
    confirm: "a confirm line with reply buttons",
} as const;

export function describeArrival(layout: Layout, options: { singleMediaKind?: "photo" | "video"; replyMode?: AnnouncementReplyMode } = {}): string {
    const { parts } = layout;
    if (parts.length <= 1) return ARRIVAL.one;
    const confirm = options.replyMode === "CONFIRM";
    const word = (part: LayoutPart): string => {
        switch (part) {
            case "photo_or_video": return options.singleMediaKind === "video" ? ARRIVAL.video : ARRIVAL.photo;
            case "album": return ARRIVAL.album;
            case "document": return ARRIVAL.file;
            case "document_album": return ARRIVAL.files;
            case "text": return confirm ? ARRIVAL.textButtons : ARRIVAL.text;
            case "follow_up": return ARRIVAL.confirm;
        }
    };
    const words = parts.map(word);
    const last = words.pop() as string;
    const list = words.length > 0 ? `${words.join(", ")}, ${ARRIVAL.then} ${last}` : last;
    return ARRIVAL.many(parts.length, list);
}

/** Раскладка и строка «Arrives as …» для текущего черновика. */
export function draftLayout(items: BroadcastMediaItem[], textHtml: string, replyMode: AnnouncementReplyMode) {
    const { media, documents } = countMedia(items);
    const layout = announcementLayout({ media, documents, visibleLength: visibleLength(textHtml), replyMode });
    const singleMedia = media === 1 ? items.find(item => item.type !== "document") : undefined;
    const arrival = describeArrival(layout, {
        replyMode,
        ...(singleMedia ? { singleMediaKind: singleMedia.type === "video" ? "video" as const : "photo" as const } : {}),
    });
    return { layout, arrival };
}

/** «It's 23:10 — people may be asleep.» — только в тихие часы 22:00–10:00 по Киеву; иначе null. */
export function nightLine(now: Date): string | null {
    if (isQuietHour(now)) {
        const clock = new Intl.DateTimeFormat("en-GB", { timeZone: PING_CONFIG.TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
        return `It's ${clock} — people may be asleep.`;
    }
    return null;
}
