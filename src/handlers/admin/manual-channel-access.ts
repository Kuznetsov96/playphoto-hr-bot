import { InlineKeyboard } from "grammy";
import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import logger from "../../core/logger.js";
import { getUserAdminRole } from "../../middleware/role-check.js";
import { userRepository } from "../../repositories/user-repository.js";
import { staffRepository } from "../../repositories/staff-repository.js";
import { accessService } from "../../services/access-service.js";
import type { MyContext } from "../../types/context.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import { escapeHtml } from "./utils.js";

export async function startManualChannelAccessFlow(ctx: MyContext) {
    ctx.session.manualChannelAccess = { step: "AWAITING_GRANT_DETAILS" };
    await ScreenManager.renderScreen(
        ctx,
        `${ADMIN_TEXTS["admin-channel-access-title"]}\n\n${ADMIN_TEXTS["admin-channel-access-prompt"]}`,
        new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-cancel"], "cancel_step"),
        { pushToStack: true }
    );
}

export async function startManualChannelRevokeFlow(ctx: MyContext) {
    ctx.session.manualChannelAccess = { step: "AWAITING_REVOKE_ID" };
    await ScreenManager.renderScreen(
        ctx,
        `${ADMIN_TEXTS["admin-channel-revoke-title"]}\n\n${ADMIN_TEXTS["admin-channel-revoke-prompt"]}`,
        new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-cancel"], "cancel_step"),
        { pushToStack: true }
    );
}

function parseTelegramId(text: string): bigint | null {
    const telegramIdRaw = text.split(/\r?\n/)[0]?.trim().replace(/[^\d]/g, "") || "";
    if (!telegramIdRaw || telegramIdRaw.length < 5) return null;
    return BigInt(telegramIdRaw);
}

function parseManualChannelAccessInput(text: string): { telegramId: bigint; fullName: string } | null {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 1) return null;

    const telegramIdRaw = lines[0]!.replace(/[^\d]/g, "");
    if (!telegramIdRaw || telegramIdRaw.length < 5) return null;

    const fullName = lines.slice(1).join(" ").replace(/\s+/g, " ").trim() || `Manual ${telegramIdRaw}`;

    return { telegramId: BigInt(telegramIdRaw), fullName };
}

export async function handleManualChannelAccess(ctx: MyContext): Promise<boolean> {
    const step = ctx.session.manualChannelAccess?.step;
    if (!step) return false;
    if (!ctx.message?.text) return false;

    const adminRole = ctx.from?.id ? await getUserAdminRole(BigInt(ctx.from.id)) : null;
    if (adminRole !== "SUPER_ADMIN") {
        delete ctx.session.manualChannelAccess;
        await ctx.reply(ADMIN_TEXTS["admin-err-access-denied"]);
        return true;
    }

    if (step === "AWAITING_REVOKE_ID") {
        await handleManualChannelRevoke(ctx);
        return true;
    }

    if (step !== "AWAITING_GRANT_DETAILS") return false;

    const parsed = parseManualChannelAccessInput(ctx.message.text);
    if (!parsed) {
        await ctx.reply(ADMIN_TEXTS["admin-channel-access-invalid"], {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-cancel"], "cancel_step")
        });
        return true;
    }

    await ctx.deleteMessage().catch(() => { });

    try {
        let user = await userRepository.findByTelegramId(parsed.telegramId);
        const [firstName, ...lastNameParts] = parsed.fullName.split(/\s+/);
        const lastName = lastNameParts.length > 0 ? lastNameParts.join(" ") : undefined;

        if (user) {
            user = await userRepository.update(user.id, {
                role: "STAFF",
                firstName: user.firstName || firstName || parsed.fullName,
                lastName: user.lastName || lastName || null,
                botBlockedAt: null,
                isBlocked: false
            });
        } else {
            user = await userRepository.create({
                telegramId: parsed.telegramId,
                firstName: firstName || parsed.fullName,
                lastName: lastName || null,
                role: "STAFF"
            });
        }

        const existingStaff = await staffRepository.findByUserId(user.id);
        if (existingStaff) {
            await staffRepository.update(existingStaff.id, {
                fullName: parsed.fullName,
                isActive: true,
                deactivatedAt: null,
                deactivatedBy: null,
                deactivatedSource: null,
                deactivatedReason: null
            });
        } else {
            await staffRepository.create({
                user: { connect: { id: user.id } },
                fullName: parsed.fullName,
                isActive: true
            });
        }

        const inviteLink = await accessService.createInviteLink(parsed.telegramId);
        if (!inviteLink) {
            throw new Error("User was saved, but invite link could not be created.");
        }

        delete ctx.session.manualChannelAccess;
        await ScreenManager.renderScreen(
            ctx,
            ADMIN_TEXTS["admin-channel-access-success"]({
                name: escapeHtml(parsed.fullName),
                telegramId: parsed.telegramId.toString(),
                inviteLink: `<a href="${inviteLink}">${inviteLink}</a>`
            }),
            new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-main-menu"], "admin_main_menu"),
            { forceNew: true }
        );
    } catch (e: any) {
        logger.error({ err: e, telegramId: parsed.telegramId }, "Manual channel access grant failed");
        await ScreenManager.renderScreen(
            ctx,
            ADMIN_TEXTS["admin-channel-access-error"]({ error: escapeHtml(e?.message || "Unknown error") }),
            new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-main-menu"], "admin_main_menu"),
            { forceNew: true }
        );
    }

    return true;
}

async function handleManualChannelRevoke(ctx: MyContext) {
    const telegramId = parseTelegramId(ctx.message!.text!);
    if (!telegramId) {
        await ctx.reply(ADMIN_TEXTS["admin-channel-revoke-invalid"], {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-cancel"], "cancel_step")
        });
        return;
    }

    await ctx.deleteMessage().catch(() => { });

    try {
        const user = await userRepository.findWithStaffProfileByTelegramId(telegramId);
        if (user && (user.adminRole || ["ADMIN", "HR", "MENTOR"].includes(user.role))) {
            delete ctx.session.manualChannelAccess;
            await ScreenManager.renderScreen(
                ctx,
                ADMIN_TEXTS["admin-channel-revoke-privileged"],
                new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-main-menu"], "admin_main_menu"),
                { forceNew: true }
            );
            return;
        }

        let displayName = `Manual ${telegramId.toString()}`;
        if (user) {
            displayName = user.staffProfile?.fullName || [user.firstName, user.lastName].filter(Boolean).join(" ") || displayName;

            if (user.staffProfile) {
                await staffRepository.update(user.staffProfile.id, {
                    isActive: false,
                    deactivatedAt: new Date(),
                    deactivatedBy: ctx.from?.id ? ctx.from.id.toString() : "SUPER_ADMIN",
                    deactivatedSource: "MANUAL_CHANNEL_ACCESS",
                    deactivatedReason: "Manual channel access revoked"
                });
            } else {
                await userRepository.update(user.id, { role: "STAFF" });
                await staffRepository.create({
                    user: { connect: { id: user.id } },
                    fullName: displayName,
                    isActive: false,
                    deactivatedAt: new Date(),
                    deactivatedBy: ctx.from?.id ? ctx.from.id.toString() : "SUPER_ADMIN",
                    deactivatedSource: "MANUAL_CHANNEL_ACCESS",
                    deactivatedReason: "Manual channel access revoked"
                });
            }
        }

        await accessService.revokeAccess(telegramId, "Manual channel access revoked");

        delete ctx.session.manualChannelAccess;
        await ScreenManager.renderScreen(
            ctx,
            ADMIN_TEXTS["admin-channel-revoke-success"]({
                name: escapeHtml(displayName),
                telegramId: telegramId.toString()
            }),
            new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-main-menu"], "admin_main_menu"),
            { forceNew: true }
        );
    } catch (e: any) {
        logger.error({ err: e, telegramId }, "Manual channel access revoke failed");
        await ScreenManager.renderScreen(
            ctx,
            ADMIN_TEXTS["admin-channel-revoke-error"]({ error: escapeHtml(e?.message || "Unknown error") }),
            new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-main-menu"], "admin_main_menu"),
            { forceNew: true }
        );
    }
}
