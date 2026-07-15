import type { InputFile } from "grammy";
import type {
    InputMediaAnimation,
    InputMediaAudio,
    InputMediaPhoto,
    InputMediaVideo,
    Location,
    MessageEntity,
    ParseMode,
    RichBlockCaption,
    RichBlockTableCell,
    RichText,
} from "grammy/types";

/** Bot API 10.2 types not yet published by @grammyjs/types 3.28.0. */
export interface InputMediaVoiceNote {
    type: "voice_note";
    media: string | InputFile;
    caption?: string;
    parse_mode?: ParseMode;
    caption_entities?: MessageEntity[];
    duration?: number;
}

export interface InputRichMessageMedia {
    id: string;
    media: InputMediaAnimation | InputMediaAudio | InputMediaPhoto | InputMediaVideo | InputMediaVoiceNote;
}

export interface InputRichBlockListItem {
    blocks: InputRichBlock[];
    has_checkbox?: true;
    is_checked?: true;
    value?: number;
    type?: "a" | "A" | "i" | "I" | "1";
}

export type InputRichBlock =
    | { type: "paragraph"; text: RichText }
    | { type: "heading"; text: RichText; size: 1 | 2 | 3 | 4 | 5 | 6 }
    | { type: "pre"; text: RichText; language?: string }
    | { type: "footer"; text: RichText }
    | { type: "divider" }
    | { type: "mathematical_expression"; expression: string }
    | { type: "anchor"; name: string }
    | { type: "list"; items: InputRichBlockListItem[] }
    | { type: "blockquote"; blocks: InputRichBlock[]; credit?: RichText }
    | { type: "pullquote"; text: RichText; credit?: RichText }
    | { type: "collage"; blocks: InputRichBlock[]; caption?: RichBlockCaption }
    | { type: "slideshow"; blocks: InputRichBlock[]; caption?: RichBlockCaption }
    | {
        type: "table";
        cells: RichBlockTableCell[][];
        is_bordered?: true;
        is_striped?: true;
        caption?: RichText;
    }
    | { type: "details"; summary: RichText; blocks: InputRichBlock[]; is_open?: true }
    | {
        type: "map";
        location: Location;
        zoom: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24;
        width: number;
        height: number;
        caption?: RichBlockCaption;
    }
    | { type: "animation"; animation: InputMediaAnimation; caption?: RichBlockCaption }
    | { type: "audio"; audio: InputMediaAudio; caption?: RichBlockCaption }
    | { type: "photo"; photo: InputMediaPhoto; caption?: RichBlockCaption }
    | { type: "video"; video: InputMediaVideo; caption?: RichBlockCaption }
    | { type: "voice_note"; voice_note: InputMediaVoiceNote; caption?: RichBlockCaption }
    | { type: "thinking"; text: RichText };

interface RichMessageOptions {
    media?: InputRichMessageMedia[];
    is_rtl?: boolean;
    skip_entity_detection?: boolean;
}

/** Exactly one content representation must be provided. */
export type LatestInputRichMessage = RichMessageOptions & (
    | { html: string; markdown?: never; blocks?: never }
    | { markdown: string; html?: never; blocks?: never }
    | { blocks: InputRichBlock[]; html?: never; markdown?: never }
);
