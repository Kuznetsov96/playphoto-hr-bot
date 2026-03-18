import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { Menu } from "@grammyjs/menu";
import type { MyContext } from "../types/context.js";
import { hrService } from "../services/hr-service.js";
import { locationRepository } from "../repositories/location-repository.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { InlineKeyboard } from "grammy";
import logger from "../core/logger.js";
import { menuRegistry } from "../utils/menu-registry.js";
import { cleanupUserSessionMessages, trackUserMessage } from "../utils/cleanup.js";
import { formatCandidateProfile } from "../utils/profile-formatter.js";
import { getPriorityLabel, getCityCode, getShortLocationName } from "../utils/location-helpers.js";
import { extractFirstName, formatCompactName } from "../utils/string-utils.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { ScreenManager } from "../utils/screen-manager.js";
import { getUserAdminRole } from "../middleware/role-check.js";
import { AdminRole, CandidateStatus } from "@prisma/client";

// --- MENUS (Declared first to prevent circular dependency issues) ---
export const hrHubMenu = new Menu<MyContext>("hr-hub-menu");
menuRegistry.register(hrHubMenu);
export const hrToolsMenu = new Menu<MyContext>("hr-tools");
menuRegistry.register(hrToolsMenu);
export const hrInboxMenu = new Menu<MyContext>("hr-inbox");
menuRegistry.register(hrInboxMenu);
export const hrInboxNewMenu = new Menu<MyContext>("hr-inbox-new");
menuRegistry.register(hrInboxNewMenu);
export const hrInboxTattooMenu = new Menu<MyContext>("hr-inbox-tattoo");
menuRegistry.register(hrInboxTattooMenu);
export const hrInboxMessagesMenu = new Menu<MyContext>("hr-inbox-messages");
menuRegistry.register(hrInboxMessagesMenu);
export const hrBroadcastCitiesMenu = new Menu<MyContext>("hr-broadcast-cities");
menuRegistry.register(hrBroadcastCitiesMenu);
export const hrBroadcastConfirmMenu = new Menu<MyContext>("hr-broadcast-confirm");
menuRegistry.register(hrBroadcastConfirmMenu);
export const hrWaitlistMenu = new Menu<MyContext>("hr-waitlist-menu");
menuRegistry.register(hrWaitlistMenu);
export const hrWaitlistCityMenu = new Menu<MyContext>("hr-waitlist-city");
menuRegistry.register(hrWaitlistCityMenu);
export const hrWaitlistLocMenu = new Menu<MyContext>("hr-waitlist-loc");
menuRegistry.register(hrWaitlistLocMenu);
export const hrWaitlistProfilesMenu = new Menu<MyContext>("hr-waitlist-profiles");
menuRegistry.register(hrWaitlistProfilesMenu);
export const hrNoSlotQuickMenu = new Menu<MyContext>("hr-no-slot-quick");
menuRegistry.register(hrNoSlotQuickMenu);
export const hrCandidateUnifiedMenu = new Menu<MyContext>("hr-candidate-unified");
menuRegistry.register(hrCandidateUnifiedMenu);
export const hrChangeLocationUnifiedMenu = new Menu<MyContext>("hr-change-location-unified");
menuRegistry.register(hrChangeLocationUnifiedMenu);
export const hrStagingConfirmMenu = new Menu<MyContext>("hr-staging-confirm");
menuRegistry.register(hrStagingConfirmMenu);

// --- FINAL STEP PIPELINE ---
export const hrFinalStepMenu = new Menu<MyContext>("hr-final-step-menu");
menuRegistry.register(hrFinalStepMenu);
export const hrFinalStepNDAMenu = new Menu<MyContext>("hr-final-step-nda");
menuRegistry.register(hrFinalStepNDAMenu);
export const hrFinalStepTestMenu = new Menu<MyContext>("hr-final-step-test");
menuRegistry.register(hrFinalStepTestMenu);
export const hrFinalStepSetupMenu = new Menu<MyContext>("hr-final-step-setup");
menuRegistry.register(hrFinalStepSetupMenu);
export const hrFinalStepActiveMenu = new Menu<MyContext>("hr-final-step-active");
menuRegistry.register(hrFinalStepActiveMenu);
export const hrFinalStepReadyMenu = new Menu<MyContext>("hr-final-step-ready");
menuRegistry.register(hrFinalStepReadyMenu);

// --- DASHBOARD MENUS ---
export const hrDashboardDatesMenu = new Menu<MyContext>("hr-dashboard-dates");
menuRegistry.register(hrDashboardDatesMenu);
export const hrDayViewMenu = new Menu<MyContext>("hr-day-view");
menuRegistry.register(hrDayViewMenu);

// --- DASHBOARD HELPERS ---
const getDayViewText = async (dateStr: string) => {
    const slots = await hrService.getDaySlots(dateStr);
    const isPending = (s: any) => {
        if (!s.isBooked || !s.candidate) return false;
        const c = s.candidate;
        return !c.hrDecision || (c.hrDecision === "ACCEPTED" && !c.notificationSent);
    };

    const booked = slots.filter(isPending).length;
    const free = slots.filter((s: any) => !s.isBooked).length;

    let text = `📅 <b>Date: ${dateStr}</b>\n\n`;
    text += `👥 Booked: <b>${booked}</b> / 🔘 Free: <b>${free}</b>\n\n`;

    if (booked > 0 || free > 0) text += `Select a slot to view or manage:`;
    else text += `No bookings for today. ✨`;

    return text;
};

// --- HUB ---
hrHubMenu.dynamic(async (ctx, range) => {
    logger.info({ userId: ctx.from?.id }, `[UX] HR Lead entering Hub`);
    const stats = await hrService.getHubStats();
    range.text(STAFF_TEXTS["hr-menu-inbox"]({ count: stats.inboxTotal }), async (ctx) => {
        ctx.session.candidatePage = 1;
        await ScreenManager.renderScreen(ctx, "📥 <b>Inbox</b>", "hr-inbox", { pushToStack: true });
    }).row();
    range.text(STAFF_TEXTS["hr-menu-calendar"]({ count: stats.todayInterviews }), async (ctx) => {
        await ScreenManager.renderScreen(ctx, "🗓️ <b>Interview Calendar</b>", "hr-dashboard-dates", { pushToStack: true });
    });
    range.text(STAFF_TEXTS["hr-menu-tools"], async (ctx) => {
        await ScreenManager.renderScreen(ctx, "📣 <b>Broadcasts & Tools</b>", "hr-tools", { pushToStack: true });
    }).row();
});

// --- INBOX ---
hrInboxMenu.dynamic(async (ctx, range) => {
    const stats = await hrService.getHubStats();
    range.text(STAFF_TEXTS["hr-menu-messages"]({ count: stats.unreadCount }), async (ctx) => {
        ctx.session.candidatePage = 1;
        await ScreenManager.renderScreen(ctx, "💬 <b>Unread Messages</b>", "hr-inbox-messages", { pushToStack: true });
    });
    range.text(STAFF_TEXTS["hr-menu-tattoo"]({ count: stats.tattooCount }), async (ctx) => {
        ctx.session.candidatePage = 1;
        await ScreenManager.renderScreen(ctx, "💍 <b>Tattoo Review</b>", "hr-inbox-tattoo", { pushToStack: true });
    });
    range.text(STAFF_TEXTS["hr-menu-new-candidates"]({ count: stats.newCandidates }), async (ctx) => {
        ctx.session.candidatePage = 1;
        await ScreenManager.renderScreen(ctx, "🆕 <b>New Candidates</b>", "hr-inbox-new", { pushToStack: true });
    }).row();

    const waitlistLabel = (stats.noSlotCount || 0) > 0
        ? `⏳ Waitlist: ${stats.waitlistCount} (🔴 ${stats.noSlotCount})`
        : `⏳ Waitlist: ${stats.waitlistCount}`;
    range.text(waitlistLabel, async (ctx) => {
        ctx.session.candidatePage = 1;
        await ScreenManager.renderScreen(ctx, "⏳ <b>Waitlist</b>", "hr-waitlist-menu", { pushToStack: true });
    }).row();

    // ONLY FOR MAIN ADMIN (SUPER_ADMIN ONLY)
    const userRole = ctx.from?.id ? await getUserAdminRole(BigInt(ctx.from.id)) : null;
    const isSuperAdmin = userRole === 'SUPER_ADMIN';

    if (isSuperAdmin) {
        range.text(STAFF_TEXTS["hr-menu-final-setup"]({ count: stats.finalStepStats.total }), async (ctx) => {
            await ScreenManager.renderScreen(ctx, "🚀 <b>Final Step Pipeline</b>", "hr-final-step-menu", { pushToStack: true });
        }).row();
    }

    range.text(STAFF_TEXTS["hr-menu-back-home"], async (ctx) => {
        await ScreenManager.goBack(ctx, await hrService.getHubText(), "hr-hub-menu");
    });
});

// --- FINAL STEP PIPELINE IMPLEMENTATION ---
const getTimeWaiting = (date: Date | null) => {
    if (!date) return "";
    const now = new Date();
    const diffMs = now.getTime() - new Date(date).getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) return ` (${diffDays}d)`;
    if (diffHours > 0) return ` (${diffHours}h)`;
    return " (<1h)";
};

hrFinalStepMenu.dynamic(async (ctx, range) => {
    const stats = await hrService.getFinalStepStats();

    range.text(`📑 NDA (${stats.ndaPending})`, async (ctx) => {
        ctx.session.candidatePage = 1;
        await ScreenManager.renderScreen(ctx, "📑 <b>NDA Pending</b>", "hr-final-step-nda", { pushToStack: true });
    }).row();

    range.text(`📝 Knowledge Test (${stats.testPending})`, async (ctx) => {
        ctx.session.candidatePage = 1;
        await ScreenManager.renderScreen(ctx, "📝 <b>Knowledge Test</b>", "hr-final-step-test", { pushToStack: true });
    }).row();

    range.text(`📸 Staging Setup (${stats.stagingSetup})`, async (ctx) => {
        ctx.session.candidatePage = 1;
        await ScreenManager.renderScreen(ctx, "📸 <b>Staging Setup</b>", "hr-final-step-setup", { pushToStack: true });
    }).row();

    range.text(`⌛ Active Staging (${stats.activeStaging})`, async (ctx) => {
        ctx.session.candidatePage = 1;
        await ScreenManager.renderScreen(ctx, "⌛ <b>Active Staging</b>", "hr-final-step-active", { pushToStack: true });
    }).row();

    range.text(`✅ Reply to Hire (${stats.readyForHire})`, async (ctx) => {
        ctx.session.candidatePage = 1;
        await ScreenManager.renderScreen(ctx, "✅ <b>Ready for Hire</b>", "hr-final-step-ready", { pushToStack: true });
    }).row();

    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "📥 <b>Inbox</b>", "hr-inbox");
    });
});

// NDA List
hrFinalStepNDAMenu.dynamic(async (ctx, range) => {
    const candidates = await hrService.getNDAPendingCandidates();
    for (const cand of candidates) {
        const waiting = getTimeWaiting(cand.ndaSentAt || cand.user.updatedAt);
        range.text(`📑 ${formatCompactName(cand.fullName)}${waiting}`, async (ctx) => {
            ctx.session.candidateData = { id: cand.id } as any;
            const text = await formatCandidateProfile(ctx as any, cand as any, { includeActionLabel: true });
            await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified", { pushToStack: true });
        }).row();
    }
    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "🚀 <b>Final Step Pipeline</b>", "hr-final-step-menu");
    });
});

// Test List
hrFinalStepTestMenu.dynamic(async (ctx, range) => {
    const candidates = await hrService.getTestPendingCandidates();
    for (const cand of candidates) {
        const waiting = getTimeWaiting(cand.ndaConfirmedAt);
        range.text(`📝 ${formatCompactName(cand.fullName)}${waiting}`, async (ctx) => {
            ctx.session.candidateData = { id: cand.id } as any;
            const text = await formatCandidateProfile(ctx as any, cand as any, { includeActionLabel: true });
            await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified", { pushToStack: true });
        }).row();
    }
    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "🚀 <b>Final Step Pipeline</b>", "hr-final-step-menu");
    });
});

// Staging Setup List
hrFinalStepSetupMenu.dynamic(async (ctx, range) => {
    const candidates = await hrService.getStagingSetupCandidates();
    for (const cand of candidates) {
        const waiting = getTimeWaiting(cand.user.updatedAt);
        range.text(`📸 ${formatCompactName(cand.fullName)}${waiting}`, async (ctx) => {
            ctx.session.candidateData = { id: cand.id } as any;
            const text = await formatCandidateProfile(ctx as any, cand as any, { includeActionLabel: true });
            await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified", { pushToStack: true });
        }).row();
    }
    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "🚀 <b>Final Step Pipeline</b>", "hr-final-step-menu");
    });
});

// Active Staging List
hrFinalStepActiveMenu.dynamic(async (ctx, range) => {
    const candidates = await hrService.getActiveStagingCandidates();
    for (const cand of candidates) {
        const dateStr = cand.firstShiftDate ? cand.firstShiftDate.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' }) : "??";
        range.text(`⌛ ${formatCompactName(cand.fullName)} • ${dateStr}`, async (ctx) => {
            ctx.session.candidateData = { id: cand.id } as any;
            const text = await formatCandidateProfile(ctx as any, cand as any, { includeActionLabel: true });
            await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified", { pushToStack: true });
        }).row();
    }
    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "🚀 <b>Final Step Pipeline</b>", "hr-final-step-menu");
    });
});

// Ready for Hire List
hrFinalStepReadyMenu.dynamic(async (ctx, range) => {
    const candidates = await hrService.getReadyForHireCandidates();
    for (const cand of candidates) {
        range.text(`✅ ${formatCompactName(cand.fullName)}`, async (ctx) => {
            ctx.session.candidateData = { id: cand.id } as any;
            const text = await formatCandidateProfile(ctx as any, cand as any, { includeActionLabel: true });
            await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified", { pushToStack: true });
        }).row();
    }
    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "🚀 <b>Final Step Pipeline</b>", "hr-final-step-menu");
    });
});

// --- WAITLIST ---
hrWaitlistMenu.dynamic(async (ctx, range) => {
    const stats = await hrService.getHubStats();
    range.text(`🗓️ No Date Fits (${stats.noSlotCount || 0})`, async (ctx) => {
        ctx.session.candidatePage = 1;
        await ScreenManager.renderScreen(ctx, "🗓️ <b>No Date Fits</b>", "hr-no-slot-quick", { pushToStack: true });
    }).row();
    range.text(`📍 Location Full (${(stats.waitlistCount || 0) - (stats.noSlotCount || 0)})`, async (ctx) => {
        ctx.session.candidatePage = 1;
        await ScreenManager.renderScreen(ctx, "🏙️ <b>Waitlist Cities</b>", "hr-waitlist-city", { pushToStack: true });
    }).row();
    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "📥 <b>Inbox</b>", "hr-inbox");
    });
});

hrNoSlotQuickMenu.dynamic(async (ctx, range) => {
    const candidates = await hrService.getWaitlistNoSlot();
    if (candidates.length === 0) {
        range.text("All caught up! ✨", (ctx) => { }).row();
    } else {
        for (const cand of candidates) {
            range.text(`🗓️ ${formatCompactName(cand.fullName)}`, async (ctx) => {
                ctx.session.candidateData = { id: cand.id } as any;
                delete ctx.session.selectedSlotId; // Not from dashboard
                const text = await formatCandidateProfile(ctx as any, cand as any, { includeActionLabel: true, actionLabel: "Needs a slot!" });
                await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified", { pushToStack: true });
            }).row();
        }
    }
    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "⏳ <b>Waitlist</b>", "hr-waitlist-menu");
    });
});

hrWaitlistCityMenu.dynamic(async (ctx, range) => {
    const cities = await hrService.getWaitlistCities();
    for (const city of cities) {
        range.text(`🏙️ ${city}`, async (ctx) => {
            ctx.session.broadcastCity = city;
            await ScreenManager.renderScreen(ctx, "📍 <b>Waitlist Locations</b>", "hr-waitlist-loc", { pushToStack: true });
        }).row();
    }
    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "⏳ <b>Waitlist</b>", "hr-waitlist-menu");
    });
});

hrWaitlistLocMenu.dynamic(async (ctx, range) => {
    const city = ctx.session.broadcastCity;
    if (!city) return;
    const locations = await hrService.getWaitlistLocationsByCity(city);
    for (const loc of locations) {
        range.text(`📍 ${loc.name} (${loc.count})`, async (ctx) => {
            ctx.session.broadcastLocationId = loc.id || "";
            ctx.session.candidatePage = 1;
            await ScreenManager.renderScreen(ctx, "👤 <b>Waitlist Profiles</b>", "hr-waitlist-profiles", { pushToStack: true });
        }).row();
    }
    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "🏙️ <b>Waitlist Cities</b>", "hr-waitlist-city");
    });
});

hrWaitlistProfilesMenu.dynamic(async (ctx, range) => {
    const city = ctx.session.broadcastCity;
    const locId = ctx.session.broadcastLocationId || null;
    const page = ctx.session.candidatePage || 1;
    if (!city) return;
    const { items, total, totalPages } = await hrService.getWaitlistCandidatesByLocationPaginated(city, locId, page, 5);
    for (const cand of items) {
        range.text(`👤 ${formatCompactName(cand.fullName)}`, async (ctx) => {
            ctx.session.candidateData = { id: cand.id } as any;
            delete ctx.session.selectedSlotId; // Not from dashboard
            const text = await formatCandidateProfile(ctx as any, cand as any, { includeActionLabel: true });
            await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified", { pushToStack: true });
        }).row();
    }
    if (page > 1) range.text("⬅️ Previous", (ctx) => { ctx.session.candidatePage = page - 1; ctx.menu.update(); });
    if (page < totalPages) range.text("Next ➡️", (ctx) => { ctx.session.candidatePage = page + 1; ctx.menu.update(); });
    range.row().text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "📍 <b>Waitlist Locations</b>", "hr-waitlist-loc");
    });
});

// --- TOOLS ---
hrToolsMenu.dynamic(async (ctx, range) => {
    range.text(STAFF_TEXTS["hr-menu-broadcast-screening"], async (ctx) => {
        await ScreenManager.renderScreen(ctx, "📣 <b>Invite New Candidates</b>", "hr-broadcast-cities", { pushToStack: true });
    }).row();
    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, await hrService.getHubText(), "hr-hub-menu");
    });
});

// --- UNIFIED CANDIDATE DETAILS ---
hrCandidateUnifiedMenu.dynamic(async (ctx, range) => {
    const candId = ctx.session.candidateData?.id;
    const slotId = ctx.session.selectedSlotId;
    if (!candId) return;
    const cand = await hrService.getCandidateDetails(candId);
    if (!cand) return;

    const cStatus = cand.status as string;
    const hrDec = (cand as any).hrDecision;

    // 1. DASHBOARD ACTIONS (If opened via Calendar)
    if (slotId) {
        if (["INTERVIEW_SCHEDULED", "SCREENING"].includes(cStatus) && !hrDec) {
            range.text("✅ Conducted", async (ctx) => {
                const result = await hrService.completeInterview(slotId);
                if (result && result.text) {
                    try {
                        const msg = await ctx.api.sendMessage(result.telegramId, result.text, { parse_mode: "HTML" });
                        await trackUserMessage(result.telegramId, msg.message_id);
                    } catch (e) { }
                }
                await ctx.answerCallbackQuery("Status: CONDUCTED");
                await ctx.menu.update();
            }).row();
            range.text("🚫 No-show", async (ctx) => {
                await hrService.markNoShow(cand.id);
                const tid = Number(cand.user.telegramId);
                try {
                    const msg = await ctx.api.sendMessage(tid, (STAFF_TEXTS as any)["hr-rejection-noshow"]);
                    await trackUserMessage(tid, msg.message_id);
                } catch (e) { }
                await ctx.answerCallbackQuery("Status: NO-SHOW");
                await ctx.menu.update();
            }).row();
            range.text(STAFF_TEXTS["hr-btn-reschedule"], async (ctx) => {
                await hrService.rescheduleCandidate(cand.id);
                const tid = Number(cand.user.telegramId);
                try {
                    const msg = await ctx.api.sendMessage(tid, (STAFF_TEXTS as any)["hr-msg-reschedule"], {
                        reply_markup: new InlineKeyboard().text("🗓️ Обрати інший час", "start_scheduling")
                    });
                    await trackUserMessage(tid, msg.message_id);
                } catch (e) { }
                await ctx.answerCallbackQuery("Status: RESCHEDULE");
                await ctx.menu.update();
            }).row();
        }
    }

    // 2. RECRUITMENT ACTIONS
    if (["SCREENING", "WAITLIST"].includes(cStatus)) {
        range.text(cand.notificationSent ? "🔔 Remind" : STAFF_TEXTS["hr-btn-invite-individual"], async (ctx) => {
            await hrService.inviteCandidate(ctx.api, cand.id);
            await ctx.answerCallbackQuery("Sent! ✅");
            await ctx.menu.update();
        }).row();
    }

    if (cStatus === "MANUAL_REVIEW") {
        range.text("✅ Approve Tattoo", async (ctx) => {
            await hrService.approveTattoo(ctx.api, cand.id);
            await ctx.answerCallbackQuery("Approved! ✅");
            await ctx.menu.update();
        });
        range.text("❌ Reject", async (ctx) => {
            await hrService.rejectCandidate(ctx.api, cand.id, "APPEARANCE");
            await ctx.answerCallbackQuery("Rejected ❌");
            await ctx.menu.update();
        }).row();
    }

    if (["INTERVIEW_COMPLETED", "DECISION_PENDING"].includes(cStatus) && !hrDec) {
        range.text(STAFF_TEXTS["hr-btn-accept-offer"], async (ctx) => {
            await hrService.makeDecision(ctx.api, cand.id, "ACCEPTED", ctx.from?.id.toString());
            await ctx.answerCallbackQuery("Accepted! ✅");
            await ctx.menu.update();
        });
        range.text(STAFF_TEXTS["hr-btn-reject"], async (ctx) => {
            await hrService.makeDecision(ctx.api, cand.id, "REJECTED", ctx.from?.id.toString());
            await ctx.answerCallbackQuery("Rejected ❌");
            await ctx.menu.update();
        }).row();
        range.text(STAFF_TEXTS["hr-btn-reschedule"], async (ctx) => {
            await hrService.rescheduleCandidate(cand.id);
            const tid = Number(cand.user.telegramId);
            try {
                const msg = await ctx.api.sendMessage(tid, (STAFF_TEXTS as any)["hr-msg-reschedule"], {
                    reply_markup: new InlineKeyboard().text("🗓️ Обрати інший час", "start_scheduling")
                });
                await trackUserMessage(tid, msg.message_id);
            } catch (e) { }
            await ctx.answerCallbackQuery("Status: RESCHEDULE");
            await ctx.menu.update();
        }).row();
    }

    // 2.5 FINAL STEP ACTIONS (SUPER_ADMIN ONLY)
    const uRole = ctx.from?.id ? await getUserAdminRole(BigInt(ctx.from.id)) : null;
    const isSuperAdmin = uRole === 'SUPER_ADMIN';

    if (isSuperAdmin) {
        // --- NDA & TEST REMINDERS ---
        if (cStatus === "NDA") {
            range.text("🔔 Ping NDA", async (ctx) => {
                await hrService.pingNDA(ctx.api, cand.id);
                await ctx.answerCallbackQuery("Ping sent! 🔔");
            }).row();
        }

        if (cStatus === "KNOWLEDGE_TEST") {
            range.text("🔔 Ping Test", async (ctx) => {
                await hrService.pingTest(ctx.api, cand.id);
                await ctx.answerCallbackQuery("Ping sent! 🔔");
            }).row();
        }

        // --- STAGING SETUP (Former OFFLINE_STAGING with notificationSent=false) ---
        if (cStatus === "STAGING_SETUP") {
            const hasDate = !!cand.firstShiftDate;
            const hasTime = !!cand.firstShiftTime;
            const hasLoc = !!cand.locationId;
            const hasPartner = !!cand.firstShiftPartnerId;

            // Direct Setup Buttons (Apple Style: No submenus for core actions)
            range.text(hasDate ? `📅 ${cand.firstShiftDate!.toLocaleDateString('uk-UA')}` : "📅 Set Date", async (ctx) => {
                ctx.session.selectedCandidateId = cand.id;
                ctx.session.step = `set_first_shift_date_${cand.id}`;
                await ctx.answerCallbackQuery();
                const { ADMIN_TEXTS } = await import("../constants/admin-texts.js");
                await ctx.reply(ADMIN_TEXTS["admin-staging-ask-date"] + "\nExample: 25.02.2026");
            });
            range.text(hasTime ? `⏰ ${cand.firstShiftTime}` : "⏰ Set Time", async (ctx) => {
                ctx.session.selectedCandidateId = cand.id;
                ctx.session.step = `set_staging_time_${cand.id}`;
                await ctx.answerCallbackQuery();
                await ctx.reply("✍️ <b>Enter staging time:</b>\nExample: 10:00-12:00", { parse_mode: "HTML", reply_markup: { force_reply: true } });
            }).row();
            range.text(hasLoc ? `📍 ${cand.location?.name || 'Loc'}` : "📍 Set Loc", async (ctx) => {
                ctx.session.selectedCandidateId = cand.id;
                await ScreenManager.renderScreen(ctx, "📍 <b>Select new staging location:</b>", "hr-change-location-unified", { pushToStack: true });
            });
            range.text(hasPartner ? `📸 ${formatCompactName(cand.firstShiftPartner?.fullName)}` : "📸 Set Partner", async (ctx) => {
                if (!hasDate || !hasLoc) {
                    return ctx.answerCallbackQuery("⚠️ Please set date and location first!");
                }
                ctx.session.selectedCandidateId = cand.id;
                await ScreenManager.renderScreen(ctx, "🔍 <b>Select a partner:</b>", "hr-staging-confirm", { pushToStack: true });
            }).row();

            // Action Button: Only active when ready (Simplified)
            if (hasDate && hasPartner && hasLoc) {
                range.text("🚀 Notify & Send to Staging", async (ctx) => {
                    ctx.session.selectedCandidateId = cand.id;
                    const result = await hrService.sendStagingNotifications(ctx.api, cand.id);
                    if (result) {
                        const candStatus = result.candidateNotified ? "✅" : "❌";
                        const partnerStatus = result.partnerNotified ? "✅" : "❌";
                        const confirmText = `📬 <b>Notifications sent!</b>\n\n` +
                            `👤 Candidate ${result.candName}: ${candStatus}\n` +
                            `📸 Partner ${result.partnerName}: ${partnerStatus}\n\n` +
                            `Status → <b>Active Staging</b>`;
                        await ctx.answerCallbackQuery("Notifications sent! ✅");
                        await ScreenManager.renderScreen(ctx, confirmText, new InlineKeyboard().text("🚀 Final Step Pipeline", "nav_final_step_pipeline"));
                    } else {
                        await ctx.answerCallbackQuery("Error! Check details. ❌");
                    }
                }).row();
            }
        }

        // --- ACTIVE STAGING (Former OFFLINE_STAGING with notificationSent=true) ---
        if (cStatus === "STAGING_ACTIVE") {
            range.text("✅ Pass Staging", async (ctx) => {
                const res = await hrService.completeOfflineStaging(cand.id, true);
                if (res) {
                    const firstName = extractFirstName(res.candidate.fullName || "");
                    await ctx.api.sendMessage(Number(res.candidate.user.telegramId), CANDIDATE_TEXTS["admin-staging-passed-activation"](firstName), { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✨ Активувати профіль", `start_onboarding_data`) });
                    await ctx.answerCallbackQuery("Passed! ✅");
                    await ctx.menu.update();
                }
            });
            range.text("❌ Fail", async (ctx) => {
                await hrService.completeOfflineStaging(cand.id, false);
                await ctx.answerCallbackQuery("Failed. ❌");
                await ctx.menu.update();
            }).row();

            range.text("🔄 Reset to Setup", async (ctx) => {
                await candidateRepository.update(cand.id, { status: "STAGING_SETUP" as any, notificationSent: false });
                await ctx.answerCallbackQuery("Reset to setup mode 🛠");
                await ctx.menu.update();
            }).row();
        }

        if (cStatus === "READY_FOR_HIRE") {
            range.text("🚀 Finalize Hiring", async (ctx) => {
                const res = await hrService.confirmFinalSchedule(cand.id);
                if (res) {
                    const { MENTOR_IDS } = await import("../config.js");
                    const mentorMsg = `🚀 <b>New photographer hired!</b>\n👤 Name: <b>${res.candidate.fullName}</b>`;
                    for (const mId of MENTOR_IDS) {
                        await ctx.api.sendMessage(mId, mentorMsg, { parse_mode: "HTML" }).catch(() => { });
                    }
                    await ctx.answerCallbackQuery("Hired! 🚀");
                    await ctx.menu.update();
                }
            }).row();
        }
    }

    // 3. CORE ACTIONS
    range.text(STAFF_TEXTS["hr-btn-write-message"], async (ctx) => {
        const userId = cand.user?.telegramId;
        if (userId) {
            await ctx.reply(STAFF_TEXTS["hr-ask-reply"]({ userId: userId.toString() }));
            ctx.session.step = `admin_reply_${userId}`;
            await ctx.answerCallbackQuery("✓");
        }
    }).row();

    if (cand.hasUnreadMessage && ctx.session.viewingFromInbox) {
        range.text("👁️ Mark as Read", async (ctx) => {
            await candidateRepository.update(cand.id, { hasUnreadMessage: false });
            await ctx.answerCallbackQuery("Marked as read! ✅");
            await ctx.menu.update();
        }).row();
    }

    // Bottom Navigation
    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        delete ctx.session.viewingFromInbox; // Clear flag on back
        await ScreenManager.goBack(ctx, "🔍 <b>Candidate Profile</b>");
    });
});

hrChangeLocationUnifiedMenu.dynamic(async (ctx, range) => {
    const candId = ctx.session.candidateData?.id;
    if (!candId) return;
    const cand = await hrService.getCandidateDetails(candId);
    if (!cand || !cand.city) return;

    const locations = await locationRepository.findByCity(cand.city);
    locations.forEach(loc => {
        const isCurrent = loc.id === cand.locationId;
        range.text(`${isCurrent ? '✅ ' : ''}${loc.name}`, async (ctx) => {
            if (isCurrent) return ctx.answerCallbackQuery("Already here.");
            await candidateRepository.update(cand.id, { location: { connect: { id: loc.id } } } as any);
            await ctx.answerCallbackQuery(`Moved! ✅`);

            const candId = ctx.session.candidateData?.id;
            if (candId) {
                const updatedCand = await hrService.getCandidateDetails(candId);
                if (updatedCand) {
                    const text = await formatCandidateProfile(ctx as any, updatedCand as any, { includeActionLabel: true });
                    await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified");
                }
            }
        }).row();
    });
    range.text(STAFF_TEXTS["hr-menu-back"], (ctx) => ScreenManager.goBack(ctx, "👤 <b>Candidate Details</b>", "hr-candidate-unified"));
});

// --- INBOX LISTS ---
hrInboxNewMenu.dynamic(async (ctx, range) => {
    const candidates = await hrService.getNewCandidates(100);
    const page = ctx.session.candidatePage || 1;
    const pageSize = 8;
    const total = candidates.length;
    const totalPages = Math.ceil(total / pageSize);
    const items = candidates.slice((page - 1) * pageSize, page * pageSize);

    for (const cand of items) {
        const cityCode = getCityCode(cand.city);
        range.text(`🆕 ${formatCompactName(cand.fullName)} [${cityCode}]`, async (ctx) => {
            ctx.session.candidateData = { id: cand.id } as any;
            delete ctx.session.selectedSlotId;
            const text = await formatCandidateProfile(ctx as any, cand as any, { includeActionLabel: true });
            await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified", { pushToStack: true });
        }).row();
    }

    if (totalPages > 1) {
        if (page > 1) range.text("⬅️ Previous", (ctx) => { ctx.session.candidatePage = page - 1; ctx.menu.update(); });
        if (page < totalPages) range.text("Next ➡️", (ctx) => { ctx.session.candidatePage = page + 1; ctx.menu.update(); });
        range.row();
    }

    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "📥 <b>Inbox</b>", "hr-inbox");
    });
});

hrInboxTattooMenu.dynamic(async (ctx, range) => {
    const candidates = await hrService.getManualReviewCandidates();
    const page = ctx.session.candidatePage || 1;
    const pageSize = 8;
    const total = candidates.length;
    const totalPages = Math.ceil(total / pageSize);
    const items = candidates.slice((page - 1) * pageSize, page * pageSize);

    for (const cand of items) {
        range.text(`💍 ${formatCompactName(cand.fullName)}`, async (ctx) => {
            ctx.session.candidateData = { id: cand.id } as any;
            delete ctx.session.selectedSlotId;
            const text = await formatCandidateProfile(ctx as any, cand as any, { includeActionLabel: true });
            await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified", { pushToStack: true });
        }).row();
    }

    if (totalPages > 1) {
        if (page > 1) range.text("⬅️ Previous", (ctx) => { ctx.session.candidatePage = page - 1; ctx.menu.update(); });
        if (page < totalPages) range.text("Next ➡️", (ctx) => { ctx.session.candidatePage = page + 1; ctx.menu.update(); });
        range.row();
    }

    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "📥 <b>Inbox</b>", "hr-inbox");
    });
});

hrInboxMessagesMenu.dynamic(async (ctx, range) => {
    const candidates = await hrService.getUnreadCandidates();
    const page = ctx.session.candidatePage || 1;
    const pageSize = 8;
    const total = candidates.length;
    const totalPages = Math.ceil(total / pageSize);
    const items = candidates.slice((page - 1) * pageSize, page * pageSize);

    for (const cand of items) {
        range.text(`💬 ${formatCompactName(cand.fullName)}`, async (ctx) => {
            ctx.session.candidateData = { id: cand.id } as any;
            ctx.session.viewingFromInbox = true; // Flag for showing 'Mark as Read'
            delete ctx.session.selectedSlotId;
            const text = await formatCandidateProfile(ctx as any, cand as any, { includeActionLabel: true, includeHistory: true, viewerRole: "HR" });
            await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified", { pushToStack: true });
        }).row();
    }

    if (totalPages > 1) {
        if (page > 1) range.text("⬅️ Previous", (ctx) => { ctx.session.candidatePage = page - 1; ctx.menu.update(); });
        if (page < totalPages) range.text("Next ➡️", (ctx) => { ctx.session.candidatePage = page + 1; ctx.menu.update(); });
        range.row();
    }

    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "📥 <b>Inbox</b>", "hr-inbox");
    });
});

// --- BROADCASTS ---
hrBroadcastCitiesMenu.dynamic(async (ctx, range) => {
    const stats = await hrService.getCityRecruitmentStats();
    if (stats.length === 0) {
        range.text("📭 No active recruitment", (ctx) => ctx.answerCallbackQuery("Everything is full! ✨")).row();
    }
    for (const s of stats) {
        const cityCode = getCityCode(s.city);
        const label = `[${cityCode}] ${s.locationName} • ${s.candidateCount}/${s.totalNeeded}`;

        range.text(label, async (ctx) => {
            if (s.candidateCount === 0) {
                return ctx.answerCallbackQuery("No new candidates to invite. 📭");
            }
            ctx.session.broadcastCity = s.city;
            ctx.session.broadcastLocationId = s.locationId;
            (ctx.session as any).broadcastLimit = s.totalNeeded > 0 ? s.totalNeeded * 3 : undefined; // Limit is 3x open slots
            const limitText = (ctx.session as any).broadcastLimit ? `(Up to ${(ctx.session as any).broadcastLimit} max)` : `(All)`;

            const text = STAFF_TEXTS["hr-info-invite-new-confirm"]({
                city: s.city,
                locationName: s.locationName || 'Any',
                count: s.candidateCount.toString(),
                totalNeeded: `${s.totalNeeded} ${limitText}`
            } as any);
            await ScreenManager.renderScreen(ctx, text, "hr-broadcast-confirm", { pushToStack: true });
        }).row();
    }
    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        delete ctx.session.broadcastLocationId;
        delete (ctx.session as any).broadcastLimit;
        await ScreenManager.goBack(ctx, "📣 <b>Broadcasts & Tools</b>", "hr-tools");
    });
});

hrBroadcastConfirmMenu.text("✅ Confirm & Send", async (ctx) => {
    const city = ctx.session.broadcastCity;
    const locationId = ctx.session.broadcastLocationId;
    const limit = (ctx.session as any).broadcastLimit;
    if (!city) return;

    const newCandidates = await hrService.getBroadcastCandidates(city, false, locationId, limit);
    await ctx.answerCallbackQuery("Broadcast started...");
    for (const cand of newCandidates) {
        await hrService.inviteCandidate(ctx.api, cand.id);
    }
    await ctx.reply(`📢 Broadcast finished! Sent ${newCandidates.length} invitations.`);
    delete ctx.session.broadcastLocationId;
    delete (ctx.session as any).broadcastLimit;
    await ScreenManager.goBack(ctx, "📣 <b>Broadcasts & Tools</b>", "hr-tools");
}).row().text("❌ Cancel", async (ctx) => {
    delete ctx.session.broadcastLocationId;
    delete (ctx.session as any).broadcastLimit;
    await ScreenManager.goBack(ctx, "📣 <b>Invite New Candidates</b>", "hr-broadcast-cities");
});

// --- DASHBOARD IMPLEMENTATIONS ---
hrDashboardDatesMenu.dynamic(async (ctx, range) => {
    const uniqueDates = await hrService.getOccupiedDates();
    if (uniqueDates.length === 0) {
        range.text("Schedule is empty 📭", (ctx) => ctx.answerCallbackQuery("Empty for now...")).row();
    } else {
        for (const dateStr of uniqueDates) {
            range.text(dateStr, async (ctx) => {
                ctx.session.selectedDate = dateStr as string;
                const text = await getDayViewText(dateStr as string);
                await ScreenManager.renderScreen(ctx, text, "hr-day-view", { pushToStack: true });
            }).row();
        }
    }
    range.row();
    range.text("➕ Add New Slots", async (ctx) => {
        delete ctx.session.selectedCandidateId;
        const { createDatePickerKb } = await import("../utils/slot-builder.js");
        await ctx.reply("📅 <b>Select Date for Interview Slots:</b>", {
            parse_mode: "HTML",
            reply_markup: createDatePickerKb("hr_sb")
        });
        await ctx.answerCallbackQuery("✓");
    }).row();
    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, await hrService.getHubText(), "hr-hub-menu");
    });
});

hrDayViewMenu.dynamic(async (ctx, range) => {
    try {
        const selectedDate = ctx.session.selectedDate;
        if (!selectedDate) {
            range.text("⚠️ No date selected", async (ctx) => {
                await ScreenManager.goBack(ctx, "🗓️ <b>Interview Calendar</b>", "hr-dashboard-dates");
            }).row();
            return;
        }
        const daySlots = await hrService.getDaySlots(selectedDate).catch(() => []);
        const isPending = (s: any) => {
            if (!s.isBooked || !s.candidate) return false;
            const c = s.candidate;
            // 1. Visible if NO decision yet
            if (!c.hrDecision) return true;
            // 2. Visible if ACCEPTED but offer not sent yet (for ⏳ status)
            if (c.hrDecision === "ACCEPTED" && !c.notificationSent) return true;
            // Otherwise hide (REJECTED or ACCEPTED+SENT)
            return false;
        };
        const bookedSlots = daySlots.filter(isPending);
        const freeSlots = daySlots.filter((s: any) => !s.isBooked);

        if (bookedSlots.length > 0) {
            range.text("BOOKED SLOTS").row();
            for (const slot of bookedSlots) {
                const timeStr = slot.startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
                const name = slot.candidate?.fullName || "Unknown";
                const c = slot.candidate;

                let icon = "📅"; // Default for future
                if (slot.startTime < new Date()) {
                    icon = "📋"; // Conducted, needs decision
                }
                if (c?.hrDecision === "ACCEPTED" && !c?.notificationSent) {
                    icon = "⏳"; // Accepted, waiting for offer
                }

                range.text(`${icon} ${timeStr} - ${name}`, async (ctx) => {
                    ctx.session.selectedSlotId = slot.id;
                    ctx.session.candidateData = { id: slot.candidate?.id } as any;
                    delete ctx.session.viewingFromInbox; // Clear flag when coming from calendar
                    const text = await formatCandidateProfile(ctx as any, slot.candidate, { interviewSlot: slot });
                    await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified", { pushToStack: true });
                }).row();
            }
            range.row();
        }
        if (freeSlots.length > 0) {
            range.text("FREE SLOTS").row();
            for (const slot of freeSlots) {
                const time = slot.startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
                range.text(`🔘 ${time}`, (ctx) => ctx.answerCallbackQuery("Available"));
                range.text("🗑️", async (ctx) => {
                    const res = await hrService.deleteInterviewSlot(slot.id);
                    if (res) {
                        await ctx.answerCallbackQuery("Deleted ✅");
                        const text = await getDayViewText(selectedDate);
                        await ScreenManager.renderScreen(ctx, text, "hr-day-view");
                    } else {
                        await ctx.answerCallbackQuery("Error ❌");
                    }
                }).row();
            }
        }
        if (bookedSlots.length === 0 && freeSlots.length === 0) {
            range.text("🤷‍♀️ No slots for this date", (ctx) => { }).row();
        }
    } catch (e) {
        console.error("[HR Dashboard] Critical error in hr-day-view:", e);
        range.text("❌ Error loading slots", (ctx) => ctx.answerCallbackQuery("Please try again")).row();
    }
    range.row().text("➕ Add time", async (ctx) => {
        const selectedDate = ctx.session.selectedDate;
        if (!selectedDate) return ctx.answerCallbackQuery("Error: No date selected");
        delete ctx.session.selectedCandidateId;
        const { createTimePickerKb } = await import("../utils/slot-builder.js");
        const dateParts = selectedDate.split('.');
        const isoDate = `${new Date().getFullYear()}-${dateParts[1]}-${dateParts[0]}`;
        ctx.session.slotBuilder = { date: isoDate };
        await ctx.reply(`🕒 <b>Adding time for ${selectedDate}</b>\n\nSelect the <b>Start Time</b>:`, {
            parse_mode: "HTML", reply_markup: createTimePickerKb("hr_sb")
        });
        await ctx.answerCallbackQuery("✓");
    }).row();
    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "🗓️ <b>Interview Calendar</b>", "hr-dashboard-dates");
    });
});

hrStagingConfirmMenu.dynamic(async (ctx, range) => {
    const candId = ctx.session.selectedCandidateId;
    if (!candId) return;

    const { hrService } = await import("../services/hr-service.js");
    const candRecord = await hrService.getCandidateDetails(candId);
    if (!candRecord || !candRecord.locationId || !candRecord.firstShiftDate) {
        range.text("⚠️ Missing details", (ctx) => { }).row();
        range.text("⬅️ Back", (ctx) => ScreenManager.goBack(ctx, "👤 <b>Candidate Details</b>", "hr-candidate-unified"));
        return;
    }

    const { staffRepository } = await import("../repositories/staff-repository.js");
    const onDuty = await staffRepository.findWithShiftAtLocation(candRecord.locationId, candRecord.firstShiftDate);

    if (onDuty.length === 0) {
        range.text("⚠️ No photographer on duty", (ctx) => { }).row();
        range.text("⬅️ Back to edit settings", (ctx) => ScreenManager.goBack(ctx, "👤 <b>Candidate Details</b>", "hr-candidate-unified"));
    } else {
        range.text("Select partner:").row();
        for (const member of onDuty) {
            const { shortenName } = await import("../utils/string-utils.js");
            range.text(`📸 ${shortenName(member.fullName)}`, async (ctx) => {
                await candidateRepository.update(candId, { firstShiftPartner: { connect: { id: member.id } } } as any);
                await ctx.answerCallbackQuery(`Partner: ${shortenName(member.fullName)} ✅`);
                // Return to candidate card — admin must explicitly confirm via "Notify & Send"
                const updatedCand = await hrService.getCandidateDetails(candId);
                if (updatedCand) {
                    const { formatCandidateProfile } = await import("../utils/profile-formatter.js");
                    const text = await formatCandidateProfile(ctx as any, updatedCand as any, { includeActionLabel: true });
                    await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified");
                } else {
                    await ScreenManager.goBack(ctx, "👤 <b>Candidate Details</b>", "hr-candidate-unified");
                }
            }).row();
        }
        range.text("⬅️ Cancel", (ctx) => ScreenManager.goBack(ctx, "👤 <b>Candidate Details</b>", "hr-candidate-unified"));
    }
});

// --- REGISTRATION ---
hrHubMenu.register(hrInboxMenu);
hrHubMenu.register(hrInboxNewMenu);
hrHubMenu.register(hrDashboardDatesMenu);
hrHubMenu.register(hrDayViewMenu);
hrHubMenu.register(hrToolsMenu);
hrHubMenu.register(hrCandidateUnifiedMenu);
hrCandidateUnifiedMenu.register(hrChangeLocationUnifiedMenu);
hrCandidateUnifiedMenu.register(hrStagingConfirmMenu);

hrInboxMenu.register(hrWaitlistMenu);
hrWaitlistMenu.register(hrNoSlotQuickMenu);
hrWaitlistMenu.register(hrWaitlistCityMenu);
hrWaitlistCityMenu.register(hrWaitlistLocMenu);
hrWaitlistLocMenu.register(hrWaitlistProfilesMenu);
hrToolsMenu.register(hrBroadcastCitiesMenu);
hrBroadcastCitiesMenu.register(hrBroadcastConfirmMenu);
hrInboxMenu.register(hrInboxTattooMenu);
hrInboxMenu.register(hrInboxMessagesMenu);
hrInboxMenu.register(hrFinalStepMenu);
hrFinalStepMenu.register(hrFinalStepNDAMenu);
hrFinalStepMenu.register(hrFinalStepTestMenu);
hrFinalStepMenu.register(hrFinalStepSetupMenu);
hrFinalStepMenu.register(hrFinalStepActiveMenu);
hrFinalStepMenu.register(hrFinalStepReadyMenu);
