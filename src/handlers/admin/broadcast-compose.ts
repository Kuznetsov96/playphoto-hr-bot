import { Composer, InlineKeyboard } from "grammy";
import type { MyContext, BroadcastMediaItem } from "../../types/context.js";
import { broadcastService } from "../../services/broadcast.js";
import { awsBusinessClient, type AnnouncementRecipientCatalogue } from "../../services/aws-business-client.js";
import { visibleLength } from "../../services/announcement-layout.js";
import { userRepository } from "../../repositories/user-repository.js";
import { getMessageHtml } from "./utils.js";
import { formatLocation } from "../../utils/location-label.js";
import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { TRAINING_MINIAPP_BASE_URL } from "../../config.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import { audit } from "../../core/audit-logger.js";
import logger from "../../core/logger.js";
import {
    MAX_DOCUMENTS, MAX_MEDIA, MAX_TEXT,
    attachmentCounters, countMedia, draftLayout, nightLine, peopleLabel,
} from "./broadcast-helpers.js";

/**
 * Создание рассылки в боте — по образцу формы вебаппа: Кому → Ответ → Сообщение → Предпросмотр.
 * Источник правды один (вебапп): адресатов считает его маршрут, раскладка и отправка те же.
 * Кнопки админки: английский, коротко, без смайлов.
 */
export const broadcastComposeHandlers = new Composer<MyContext>();

type Draft = NonNullable<MyContext["session"]["broadcastData"]>;

const UNSUPPORTED = "This type isn't supported. Send it as a file.";

const blankDraft = (): Draft => ({
    step: "TO",
    everyone: false,
    cityNames: [],
    locationPublicIds: [],
    reminders: true,
    media: [],
});

function escape(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function isAnnouncementAdmin(ctx: MyContext): Promise<boolean> {
    if (!ctx.from) return false;
    const { getUserAdminRole } = await import("../../middleware/role-check.js");
    const { hasAnyRole } = await import("../../config/roles.js");
    const role = await getUserAdminRole(BigInt(ctx.from.id));
    return hasAnyRole(role, "SUPER_ADMIN", "CO_FOUNDER", "SUPPORT");
}

/** Имя автора — как для рассылок из бота в синке: профиль сотрудника, имя, @ник. */
async function resolveActorName(telegramId: number): Promise<string> {
    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId)).catch(() => null);
    const full = user?.staffProfile?.fullName?.trim();
    if (full) return full.slice(0, 300);
    const parts = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
    if (parts) return parts.slice(0, 300);
    if (user?.username) return `@${user.username}`.slice(0, 300);
    return "Telegram user";
}

const selectionOf = (data: Draft) => ({
    everyone: data.everyone,
    cityNames: data.cityNames,
    locationPublicIds: data.locationPublicIds,
});

/** «34 people will get it» по тому же маршруту, что у вебаппа; null — не удалось посчитать. */
async function countPeople(data: Draft): Promise<number | null> {
    try {
        return (await awsBusinessClient.resolveAnnouncementRecipients(selectionOf(data))).count;
    } catch (error) {
        logger.warn({ err: error }, "Announcement recipients count failed");
        return null;
    }
}

const countLine = (count: number | null): string =>
    count === null ? "Couldn't count the people. Try again."
        : count === 0 ? "No one will get it."
            : `${peopleLabel(count)} will get it`;

async function loadCatalogue(): Promise<AnnouncementRecipientCatalogue | null> {
    try {
        return await awsBusinessClient.getAnnouncementRecipientCatalogue();
    } catch (error) {
        logger.warn({ err: error }, "Announcement recipient catalogue failed");
        return null;
    }
}

/** Ссылка на рассылку в вебаппе; адрес вебаппа не задан или не https (Telegram не принимает иные ссылки в кнопках) — кнопки нет. */
export function announcementWebUrl(publicId: string | undefined | null): string | null {
    if (!publicId || !TRAINING_MINIAPP_BASE_URL || !/^https:\/\//iu.test(TRAINING_MINIAPP_BASE_URL.trim())) return null;
    return `${TRAINING_MINIAPP_BASE_URL.replace(/\/+$/u, "")}/owner/announcements/${encodeURIComponent(publicId)}`;
}

async function show(ctx: MyContext, text: string, kb: InlineKeyboard, forceNew = false) {
    await ScreenManager.renderScreen(ctx, text, kb, forceNew ? { forceNew: true } : {});
}

// --- Entry ---

export async function startStatelessBroadcast(ctx: MyContext) {
    ctx.session.adminFlow = "BROADCAST";
    ctx.session.step = "idle";
    ctx.session.candidateData = {};
    delete ctx.session.taskData;
    delete ctx.session.taskCreation;
    delete ctx.session.bulkTaskData;
    delete ctx.session.manualChannelAccess;
    delete ctx.session.broadcastDraft;
    delete ctx.session.supportData?.step;
    delete ctx.session.supportData?.replyingToUserId;
    ctx.session.broadcastData = blankDraft();
    await renderTo(ctx);
}

const cancelRow = (kb: InlineKeyboard) => kb.text("Cancel", "br_cancel").danger();

async function renderTo(ctx: MyContext) {
    const data = ctx.session.broadcastData;
    if (!data) return;
    data.step = "TO";
    const kb = new InlineKeyboard()
        .text("Everyone", "br_to_all").row()
        .text("By city", "br_to_city").row()
        .text("By location", "br_to_loc").row();
    cancelRow(kb);
    await show(ctx, "<b>To</b>\nWho should get this announcement?", kb);
}

async function renderSelection(ctx: MyContext, kind: "city" | "loc") {
    const data = ctx.session.broadcastData;
    if (!data) return;
    data.step = kind === "city" ? "CITIES" : "LOCATIONS";
    const catalogue = await loadCatalogue();
    if (!catalogue) {
        const kb = new InlineKeyboard().text("Back", "br_to_back");
        await show(ctx, "Couldn't load the list. Try again in a minute.", kb);
        return;
    }
    const kb = new InlineKeyboard();
    if (kind === "city") {
        data.cityList = catalogue.cities.map(city => city.name);
        catalogue.cities.forEach((city, index) => {
            const mark = data.cityNames.includes(city.name) ? "✓ " : "";
            kb.text(`${mark}${city.name}`, `br_tc_${index}`).row();
        });
    } else {
        for (const city of catalogue.cities) {
            for (const location of city.locations) {
                const mark = data.locationPublicIds.includes(location.publicId) ? "✓ " : "";
                kb.text(`${mark}${formatLocation({ name: location.name, city: city.name }, "listing")}`, `br_tl_${location.publicId}`).row();
            }
        }
    }
    const selected = kind === "city" ? data.cityNames.length : data.locationPublicIds.length;
    const count = selected > 0 ? await countPeople(data) : null;
    if (selected > 0 && count !== null && count > 0) kb.text(`Continue (${selected})`, "br_sel_next").row();
    kb.text("Back", "br_to_back");
    const heading = kind === "city" ? "<b>By city</b>\nChoose one or more cities." : "<b>By location</b>\nChoose one or more locations.";
    await show(ctx, selected > 0 ? `${heading}\n\n${countLine(count)}` : heading, kb);
}

async function renderReply(ctx: MyContext, confirmOptions = false) {
    const data = ctx.session.broadcastData;
    if (!data) return;
    data.step = "REPLY";
    const kb = new InlineKeyboard();
    if (confirmOptions) {
        kb.text(`Reminders: ${data.reminders ? "On" : "Off"}`, "br_rem_toggle").row()
            .text("Continue", "br_reply_next").row()
            .text("Back", "br_reply_choice");
        await show(ctx, "<b>Reply</b>\nPeople get Confirm and Decline buttons.\n\nReminders ask again if they haven't answered.", kb);
        return;
    }
    kb.text("Ask to confirm", "br_reply_confirm").row()
        .text("No reply needed", "br_reply_none").row()
        .text("Back", "br_reply_back");
    await show(ctx, "<b>Reply</b>\nDo you need an answer from people?", kb);
}

function messageScreenText(data: Draft): string {
    const lines = ["<b>Message</b>", "Send the text and attachments. Photos and videos — up to 10, files — up to 10.", "", attachmentCounters(data.media)];
    lines.push(data.textHtml ? `Text: ${visibleLength(data.textHtml)} of ${MAX_TEXT} characters` : "Text: none yet");
    if (data.notice) lines.push("", escape(data.notice));
    return lines.join("\n");
}

function messageScreen(data: Draft) {
    const kb = new InlineKeyboard()
        .text("Continue", "br_msg_next").row()
        .text("Clear", "br_msg_clear").row()
        .text("Back", "br_msg_back");
    const text = messageScreenText(data);
    delete data.notice;
    return { text, kb };
}

async function renderMessage(ctx: MyContext, forceNew = false) {
    const data = ctx.session.broadcastData;
    if (!data) return;
    data.step = "MESSAGE";
    if (!forceNew) delete data.lastGroupId;
    const { text, kb } = messageScreen(data);
    await show(ctx, text, kb, forceNew);
    // Запоминаем сообщение-экран: части альбома правят его на месте, а не шлют новое.
    const id = ctx.session.messagesToDelete?.at(-1);
    if (id !== undefined) data.screenMessageId = id;
}

async function renderPreview(ctx: MyContext, forceNew = false, notice?: string) {
    const data = ctx.session.broadcastData;
    if (!data) return;
    data.step = "PREVIEW";
    const count = await countPeople(data);
    const replyMode = data.replyMode ?? "NONE";
    const textHtml = data.textHtml ?? "";
    const { arrival } = draftLayout(data.media, textHtml, replyMode);

    const lines = ["<b>Preview</b>", ""];
    if (!textHtml) lines.push("<i>No text</i>");
    else if (visibleLength(textHtml) > 2500) lines.push(`<i>The text is ${visibleLength(textHtml)} characters. Send the test to read it.</i>`);
    else lines.push(textHtml);
    if (data.media.length > 0) lines.push("", attachmentCounters(data.media));
    lines.push("", arrival);
    lines.push(replyMode === "CONFIRM" ? `Ask to confirm · Reminders: ${data.reminders ? "On" : "Off"}` : "No reply needed");
    const night = nightLine(new Date());
    if (night) lines.push(night);
    lines.push("", countLine(count));
    if (notice) lines.push("", escape(notice));

    const kb = new InlineKeyboard().text("Send test to me", "b_test").row();
    if (count !== null && count > 0) kb.text(`Send to ${peopleLabel(count)}`, "b_send").row();
    kb.text("Back", "br_prev_back").text("Cancel", "br_cancel").danger();
    await show(ctx, lines.join("\n"), kb, forceNew);
}

// --- To ---

broadcastComposeHandlers.callbackQuery("br_new", async (ctx) => {
    await startStatelessBroadcast(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

broadcastComposeHandlers.callbackQuery("br_to_back", async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data) return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    await renderTo(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

broadcastComposeHandlers.callbackQuery("br_to_all", async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data) return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    data.everyone = true;
    data.cityNames = [];
    data.locationPublicIds = [];
    await renderReply(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

broadcastComposeHandlers.callbackQuery(/^br_to_(city|loc)$/, async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data) return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    const kind = ctx.match![1] as "city" | "loc";
    data.everyone = false;
    // Города и точки не смешиваются, как в вебаппе: выбор переключает режим.
    if (kind === "city") data.locationPublicIds = []; else data.cityNames = [];
    await renderSelection(ctx, kind);
    await ctx.answerCallbackQuery().catch(() => { });
});

broadcastComposeHandlers.callbackQuery(/^br_tc_(\d+)$/, async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data) return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    const name = data.cityList?.[Number(ctx.match![1])];
    if (!name) return ctx.answerCallbackQuery("The list changed. Open it again.").catch(() => { });
    data.cityNames = data.cityNames.includes(name) ? data.cityNames.filter(n => n !== name) : [...data.cityNames, name];
    await renderSelection(ctx, "city");
    await ctx.answerCallbackQuery().catch(() => { });
});

broadcastComposeHandlers.callbackQuery(/^br_tl_([0-9a-f-]{36})$/i, async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data) return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    const id = ctx.match![1]!;
    data.locationPublicIds = data.locationPublicIds.includes(id) ? data.locationPublicIds.filter(x => x !== id) : [...data.locationPublicIds, id];
    await renderSelection(ctx, "loc");
    await ctx.answerCallbackQuery().catch(() => { });
});

broadcastComposeHandlers.callbackQuery("br_sel_next", async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data) return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    if (data.cityNames.length === 0 && data.locationPublicIds.length === 0) {
        return ctx.answerCallbackQuery("Choose at least one.").catch(() => { });
    }
    await renderReply(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

/** Из старой точки входа (кнопка «назад к городам» в чужом потоке): снова экран выбора города. */
export async function renderCitySelection(ctx: MyContext) {
    await renderSelection(ctx, "city");
}

// --- Reply ---

broadcastComposeHandlers.callbackQuery("br_reply_confirm", async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data) return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    data.replyMode = "CONFIRM";
    await renderReply(ctx, true);
    await ctx.answerCallbackQuery().catch(() => { });
});

broadcastComposeHandlers.callbackQuery("br_rem_toggle", async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data) return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    data.reminders = !data.reminders;
    await renderReply(ctx, true);
    await ctx.answerCallbackQuery().catch(() => { });
});

broadcastComposeHandlers.callbackQuery("br_reply_none", async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data) return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    data.replyMode = "NONE";
    await renderMessage(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

broadcastComposeHandlers.callbackQuery("br_reply_next", async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data) return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    data.replyMode = "CONFIRM";
    await renderMessage(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

broadcastComposeHandlers.callbackQuery("br_reply_choice", async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data) return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    await renderReply(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

broadcastComposeHandlers.callbackQuery("br_reply_back", async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data) return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    if (data.cityNames.length > 0) await renderSelection(ctx, "city");
    else if (data.locationPublicIds.length > 0) await renderSelection(ctx, "loc");
    else await renderTo(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

// --- Message ---

broadcastComposeHandlers.callbackQuery("br_msg_back", async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data) return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    await renderReply(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

broadcastComposeHandlers.callbackQuery("br_msg_clear", async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data) return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    delete data.textHtml;
    data.media = [];
    await renderMessage(ctx);
    await ctx.answerCallbackQuery("Cleared.").catch(() => { });
});

broadcastComposeHandlers.callbackQuery("br_msg_next", async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data) return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    if (!data.textHtml && data.media.length === 0) {
        return ctx.answerCallbackQuery("Add text or an attachment first.").catch(() => { });
    }
    await renderPreview(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

/** Одно вложение из сообщения админа; null — тип не поддерживается. */
function attachmentOf(message: NonNullable<MyContext["message"]>): BroadcastMediaItem | null | "none" {
    if (message.voice || message.video_note || message.audio || message.animation || message.sticker || message.rich_message || message.checklist) return null;
    if (message.photo?.length) {
        const best = message.photo[message.photo.length - 1]!;
        return { type: "photo", fileId: best.file_id, width: best.width, height: best.height };
    }
    if (message.video) {
        const v = message.video;
        return {
            type: "video", fileId: v.file_id,
            ...(v.file_name ? { fileName: v.file_name } : {}),
            width: v.width, height: v.height, durationSec: v.duration,
        };
    }
    if (message.document) {
        return {
            type: "document", fileId: message.document.file_id,
            ...(message.document.file_name ? { fileName: message.document.file_name } : {}),
            ...(message.document.mime_type ? { mimeType: message.document.mime_type } : {}),
        };
    }
    return "none";
}

export async function handleBroadcastContent(ctx: MyContext) {
    const data = ctx.session.broadcastData;
    if (!data || ctx.session.adminFlow !== "BROADCAST" || data.step !== "MESSAGE") return false;
    if (ctx.chat?.type !== "private") return false;
    if (!(await isAnnouncementAdmin(ctx))) return false;
    const message = ctx.message;
    if (!message) return false;

    const attachment = attachmentOf(message);
    if (attachment === null) {
        await ctx.reply(UNSUPPORTED);
        return true;
    }

    const html = getMessageHtml(message);
    const length = visibleLength(html);
    if (length > MAX_TEXT) {
        await ctx.reply(`The text is too long: ${length} of ${MAX_TEXT} characters. Shorten it and send it again. Nothing was added.`);
        return true;
    }

    const hasText = html.replace(/<[^>]*>/g, "").trim().length > 0;
    if (attachment === "none" && !hasText) {
        await ctx.reply("Send some text or an attachment.");
        return true;
    }

    if (attachment !== "none") {
        const counts = countMedia(data.media);
        const isDocument = attachment.type === "document";
        if (isDocument && counts.documents >= MAX_DOCUMENTS) {
            data.notice = `Files: up to ${MAX_DOCUMENTS}. The extra file was not added.`;
        } else if (!isDocument && counts.media >= MAX_MEDIA) {
            data.notice = `Photos and videos: up to ${MAX_MEDIA}. The extra one was not added.`;
        } else {
            data.media = [...data.media, attachment];
        }
    }
    // Текст сообщения или подпись (подпись альбома — на одном из его сообщений) становится текстом рассылки.
    if (hasText) data.textHtml = html;

    try { await ctx.deleteMessage(); } catch { }
    const groupId = message.media_group_id;
    if (groupId && groupId === data.lastGroupId && data.screenMessageId !== undefined) {
        // Следующая часть того же альбома: экран правим на месте, новое сообщение не шлём.
        const { text, kb } = messageScreen(data);
        await ctx.api.editMessageText(ctx.chat!.id, data.screenMessageId, text, {
            parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true },
        }).catch(() => { });
        return true;
    }
    if (groupId) data.lastGroupId = groupId; else delete data.lastGroupId;
    await renderMessage(ctx, true);
    return true;
}

// --- Preview ---

broadcastComposeHandlers.callbackQuery("br_prev_back", async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data) return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    await renderMessage(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

broadcastComposeHandlers.callbackQuery("b_test", async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data || data.step !== "PREVIEW") return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    if (!(await isAnnouncementAdmin(ctx))) return ctx.answerCallbackQuery().catch(() => { });
    await ctx.answerCallbackQuery("Sending the test…").catch(() => { });
    try {
        const replyMode = data.replyMode ?? "NONE";
        const textHtml = data.textHtml ?? "";
        const { layout } = draftLayout(data.media, textHtml, replyMode);
        await broadcastService.sendTestBroadcast(
            ctx.api, ctx.from!.id, textHtml,
            data.media.length > 0 ? data.media : undefined,
            replyMode === "CONFIRM" ? "default" : "none",
            layout.textAsCaption, true,
        );
        audit({ event: "broadcast_test", result: "success", actorType: "admin", telegramId: ctx.from?.id, entityType: "broadcast", updateId: ctx.update.update_id });
        // Предпросмотр заново — под тестовыми сообщениями, чтобы «Send to N people» был перед глазами.
        await renderPreview(ctx, true);
    } catch (e: any) {
        logger.error({ err: e }, "Announcement test failed");
        await renderPreview(ctx, true, `Couldn't send the test: ${e.message}`);
    }
});

broadcastComposeHandlers.callbackQuery("b_send", async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data || data.step !== "PREVIEW") return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    if (!(await isAnnouncementAdmin(ctx))) return ctx.answerCallbackQuery().catch(() => { });
    data.step = "SENDING";
    await ctx.answerCallbackQuery("Sending…").catch(() => { });
    let sent: { count: number; broadcastId: number; publicId: string };
    try {
        const name = await resolveActorName(ctx.from!.id);
        sent = await broadcastService.createBotAnnouncement(
            ctx.api,
            { telegramId: ctx.from!.id, name },
            {
                target: selectionOf(data),
                replyMode: data.replyMode ?? "NONE",
                reminders: (data.replyMode ?? "NONE") === "CONFIRM" && data.reminders,
                textHtml: data.textHtml ?? "",
                media: data.media.map(item => ({
                    kind: item.type as "photo" | "video" | "document",
                    fileId: item.fileId,
                    ...(item.fileName ? { fileName: item.fileName } : {}),
                    ...(item.width != null ? { width: item.width } : {}),
                    ...(item.height != null ? { height: item.height } : {}),
                    ...(item.durationSec != null ? { durationSec: item.durationSec } : {}),
                })),
            },
        );
    } catch (e: any) {
        data.step = "PREVIEW";
        audit({ event: "broadcast_send", result: "failed", actorType: "admin", telegramId: ctx.from?.id, entityType: "broadcast", updateId: ctx.update.update_id, error: e.message });
        logger.error({ err: e }, "Announcement send failed");
        await ctx.reply(e.message === "NO_RECIPIENTS" ? "No one will get it. Change the recipients." : `Couldn't send: ${e.message}`);
        return;
    }
    // Рассылка уже ушла: что бы ни случилось с экраном успеха, отправку не отменяем и не «проваливаем».
    const { count, broadcastId, publicId } = sent;
    audit({ event: "broadcast_send", result: "success", actorType: "admin", telegramId: ctx.from?.id, entityType: "broadcast", updateId: ctx.update.update_id, context: { count, broadcastId, publicId } });
    delete ctx.session.broadcastData;
    delete ctx.session.broadcastDraft;
    if (ctx.session.adminFlow === "BROADCAST") delete ctx.session.adminFlow;
    try {
        const kb = new InlineKeyboard();
        const webUrl = announcementWebUrl(publicId);
        if (webUrl) kb.url("Open in web", webUrl).row();
        kb.text("New announcement", "br_new").row().text("Back to announcements", "br_to_hub");
        await show(ctx, `Sent to ${peopleLabel(count)}.`, kb, true);
    } catch (e) {
        logger.warn({ err: e }, "Announcement success screen failed; sent a plain reply");
        await ctx.reply(`Sent to ${peopleLabel(count)}.`).catch(() => { });
    }
});

// --- Cancel ---

broadcastComposeHandlers.callbackQuery("br_cancel", async (ctx) => {
    delete ctx.session.broadcastData;
    delete ctx.session.broadcastDraft;
    if (ctx.session.adminFlow === "BROADCAST") delete ctx.session.adminFlow;
    await ctx.answerCallbackQuery("Cancelled.").catch(() => { });
    await ScreenManager.goBack(ctx, ADMIN_TEXTS["admin-sys-broadcast"], "admin-broadcast-hub");
});

// Стикер приходит не через общий фильтр сообщений админки (он протекал бы в ответы поддержки,
// массовые задачи и т.д.): отказ живёт здесь и только на шаге «Message».
broadcastComposeHandlers.on("message:sticker", async (ctx, next) => {
    const data = ctx.session.broadcastData;
    if (!data || ctx.session.adminFlow !== "BROADCAST" || data.step !== "MESSAGE" || ctx.chat?.type !== "private") return next();
    if (!(await isAnnouncementAdmin(ctx))) return next();
    await ctx.reply(UNSUPPORTED);
});
