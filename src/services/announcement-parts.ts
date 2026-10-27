import { Readable } from "node:stream";
import { InputFile } from "grammy";
import type { BroadcastMediaItem } from "../types/context.js";

type ButtonType = "default" | "preferences" | "none";

export interface OpenedAttachment {
    stream: ReadableStream<Uint8Array>;
}

export interface AnnouncementPartsInput {
    text: string;
    /** Фото и видео по порядку. */
    media: BroadcastMediaItem[];
    /** Файлы-документы по порядку. */
    documents: BroadcastMediaItem[];
    /** Решение вебаппа: единственное вложение несёт текст подписью. Длину бот не пересчитывает. */
    textAsCaption: boolean;
    /** parse_mode и reply_markup, как у обычного текстового сообщения рассылки. */
    extra: Record<string, unknown>;
    buttonType: ButtonType;
    /** Уже известные file_id по publicId вложения. */
    fileIds: Record<string, string>;
    openAttachment: (publicId: string) => Promise<OpenedAttachment>;
    /** Текст-пояснение под кнопкой, когда своего текста нет. */
    followUpText: (buttonType: ButtonType) => string;
}

export interface AnnouncementPartsResult {
    /** Сообщение с кнопками (или последнее сообщение без них); null, если текста нет. */
    buttonMessage: { message_id: number } | null;
    /** Все ушедшие сообщения по порядку, включая buttonMessage. */
    partMessageIds: number[];
    /** file_id, узнанные из ответов Telegram в этом вызове. */
    learnedFileIds: Record<string, string>;
}

/**
 * Отправка частей не дошла до конца: что успело уйти и какие file_id узнали,
 * чтобы вызывающий записал части и не слал их заново.
 */
export class AnnouncementPartsError extends Error {
    constructor(
        readonly partMessageIds: number[],
        readonly learnedFileIds: Record<string, string>,
        cause: unknown,
    ) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
    }
}

type SentMessage = {
    message_id: number;
    photo?: Array<{ file_id: string }>;
    video?: { file_id: string };
    document?: { file_id: string };
};

const fileIdOf = (item: BroadcastMediaItem, message: SentMessage): string | undefined => {
    if (item.type === "photo") return message.photo?.[message.photo.length - 1]?.file_id;
    if (item.type === "video") return message.video?.file_id;
    return message.document?.file_id;
};

/**
 * Отправляет вложения рассылки вебаппа и текст в порядке «Раскладки»:
 * одно вложение с подписью — одно сообщение; иначе медиа, документы, затем текст
 * с кнопками. Альбомы кнопок не несут. Вложение без file_id уходит потоком
 * (`InputFile`), без буферизации в память.
 */
export async function sendAnnouncementParts(
    api: any,
    chatId: number,
    input: AnnouncementPartsInput,
): Promise<AnnouncementPartsResult> {
    const { text, media, documents, textAsCaption, extra, buttonType, fileIds, openAttachment } = input;
    const partMessageIds: number[] = [];
    const learnedFileIds: Record<string, string> = {};
    const known = (item: BroadcastMediaItem): string | undefined =>
        (item.attachmentPublicId ? fileIds[item.attachmentPublicId] ?? learnedFileIds[item.attachmentPublicId] : undefined)
        || item.fileId || undefined;

    const source = async (item: BroadcastMediaItem): Promise<string | InputFile> => {
        const fileId = known(item);
        if (fileId) return fileId;
        const opened = await openAttachment(item.attachmentPublicId as string);
        return new InputFile(Readable.fromWeb(opened.stream as never), item.fileName ?? "file");
    };
    const learn = (item: BroadcastMediaItem, message: SentMessage): void => {
        if (!item.attachmentPublicId || known(item)) return;
        const fileId = fileIdOf(item, message);
        if (fileId) learnedFileIds[item.attachmentPublicId] = fileId;
    };
    const record = (items: BroadcastMediaItem[], messages: SentMessage[]): void => {
        messages.forEach((message, index) => {
            partMessageIds.push(message.message_id);
            const item = items[index];
            if (item) learn(item, message);
        });
    };
    const videoOptions = (item: BroadcastMediaItem): Record<string, unknown> => ({
        supports_streaming: true,
        ...(item.width ? { width: item.width } : {}),
        ...(item.height ? { height: item.height } : {}),
        ...(item.durationSec ? { duration: item.durationSec } : {}),
    });
    const single = async (item: BroadcastMediaItem, options: Record<string, unknown>): Promise<SentMessage> => {
        const file = await source(item);
        if (item.type === "photo") return api.sendPhoto(chatId, file, options);
        if (item.type === "video") return api.sendVideo(chatId, file, { ...videoOptions(item), ...options });
        return api.sendDocument(chatId, file, options);
    };
    const album = async (items: BroadcastMediaItem[]): Promise<void> => {
        const group = [];
        for (const item of items) {
            const file = await source(item);
            group.push(item.type === "video"
                ? { type: "video", media: file, ...videoOptions(item) }
                : { type: item.type, media: file });
        }
        record(items, await api.sendMediaGroup(chatId, group));
    };
    const sendGroup = async (items: BroadcastMediaItem[]): Promise<void> => {
        if (items.length === 1) record(items, [await single(items[0] as BroadcastMediaItem, {})]);
        else if (items.length > 1) await album(items);
    };

    try {
        const all = [...media, ...documents];
        if (textAsCaption && all.length === 1) {
            const item = all[0] as BroadcastMediaItem;
            const options: Record<string, unknown> = { ...extra, ...(text ? { caption: text } : {}) };
            const message = await single(item, options);
            record([item], [message]);
            return { buttonMessage: message, partMessageIds, learnedFileIds };
        }

        await sendGroup(media);
        await sendGroup(documents);

        let buttonMessage: SentMessage | null = null;
        if (text || buttonType !== "none") {
            buttonMessage = await api.sendMessage(chatId, text || input.followUpText(buttonType), extra);
            if (buttonMessage) partMessageIds.push(buttonMessage.message_id);
        }
        return { buttonMessage, partMessageIds, learnedFileIds };
    } catch (error) {
        throw new AnnouncementPartsError(partMessageIds, learnedFileIds, error);
    }
}
