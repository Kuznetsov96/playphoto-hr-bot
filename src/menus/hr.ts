import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { Menu } from "@grammyjs/menu";
import { formatLocation } from "../utils/location-label.js";
import type { MyContext } from "../types/context.js";
import { hrService } from "../services/hr-service.js";
import { locationRepository } from "../repositories/location-repository.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { InlineKeyboard } from "grammy";
import logger from "../core/logger.js";
import { menuRegistry } from "../utils/menu-registry.js";
import { trackUserMessage } from "../utils/cleanup.js";
import { formatCandidateProfile } from "../utils/profile-formatter.js";
import { extractFirstName, formatCompactName } from "../utils/string-utils.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { ScreenManager } from "../utils/screen-manager.js";
import { getUserAdminRole } from "../middleware/role-check.js";
import { buildSignedCallback } from "../utils/signed-callback.js";

// --- MENUS (Declared first to prevent circular dependency issues) ---
// NOTE: The recruiter's own HR hub (Inbox, Calendar, Hiring Needs, Broadcast Tools,
// Candidate Pools) was removed 2026-09-03 — the recruiter now works entirely in the
// web app. What remains below is used exclusively by the owner/admin "Final Step
// Pipeline" flow (registered via src/handlers/admin/bootstrap.ts) and by the
// admin/mentor candidate-detail views (src/handlers/admin/recruitment.ts,
// src/handlers/admin/search.ts). Do not assume this file is one unit.
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
export const hrFinalStepFillingMenu = new Menu<MyContext>("hr-final-step-filling");
menuRegistry.register(hrFinalStepFillingMenu);
export const hrFinalStepScheduleMenu = new Menu<MyContext>("hr-final-step-schedule");
menuRegistry.register(hrFinalStepScheduleMenu);

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

    range.text(`⌛ Active Staging Legacy (${stats.activeStaging})`, async (ctx) => {
        ctx.session.candidatePage = 1;
        await ScreenManager.renderScreen(ctx, "⌛ <b>Active Staging</b>\nLegacy candidates only.", "hr-final-step-active", { pushToStack: true });
    }).row();

    range.text(`📝 Filling Data (${stats.fillingData})`, async (ctx) => {
        ctx.session.candidatePage = 1;
        await ScreenManager.renderScreen(ctx, "📝 <b>Filling Documents</b>\nWaiting for candidates to submit their data, documents, and schedule preferences.", "hr-final-step-filling", { pushToStack: true });
    }).row();

    range.text(`⏳ Ready for Schedule (${stats.readyForSchedule})`, async (ctx) => {
        ctx.session.candidatePage = 1;
        await ScreenManager.renderScreen(ctx, "⏳ <b>Ready for Schedule</b>\nAdd to Google Sheets → Full Sync.", "hr-final-step-schedule", { pushToStack: true });
    }).row();

    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "🎯 <b>Recruitment</b>", "admin-ops");
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
            const text = await formatCandidateProfile(ctx as any, cand as any, {
                includeActionLabel: true,
                includeHistory: true,
                viewerRole: "HR"
            });
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
            const text = await formatCandidateProfile(ctx as any, cand as any, {
                includeActionLabel: true,
                includeHistory: true,
                viewerRole: "HR"
            });
            await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified", { pushToStack: true });
        }).row();
    }
    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "🚀 <b>Final Step Pipeline</b>", "hr-final-step-menu");
    });
});

// Filling Data List (READY_FOR_HIRE — waiting for candidate to submit documents)
hrFinalStepFillingMenu.dynamic(async (ctx, range) => {
    const candidates = await hrService.getFillingDataCandidates();
    for (const cand of candidates) {
        const waiting = getTimeWaiting(cand.statusChangedAt || cand.user.updatedAt);
        range.text(`📝 ${formatCompactName(cand.fullName)}${waiting}`, async (ctx) => {
            ctx.session.candidateData = { id: cand.id } as any;
            const text = await formatCandidateProfile(ctx as any, cand as any, { includeActionLabel: true });
            await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified", { pushToStack: true });
        }).row();
    }
    if (candidates.length === 0) {
        range.text("All candidates submitted! ✨", (ctx) => ctx.answerCallbackQuery().catch(() => { })).row();
    }
    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "🚀 <b>Final Step Pipeline</b>", "hr-final-step-menu");
    });
});

// Ready for Schedule List (AWAITING_FIRST_SHIFT — completed docs, need schedule + sync)
hrFinalStepScheduleMenu.dynamic(async (ctx, range) => {
    const candidates = await hrService.getReadyForScheduleCandidates();
    for (const cand of candidates) {
        const waiting = getTimeWaiting(cand.statusChangedAt || cand.user.updatedAt);
        const locName = cand.location ? ` • ${formatLocation(cand.location, "in-city")}` : '';
        range.text(`⏳ ${formatCompactName(cand.fullName)}${locName}${waiting}`, async (ctx) => {
            ctx.session.candidateData = { id: cand.id } as any;
            const text = await formatCandidateProfile(ctx as any, cand as any, { includeActionLabel: true });
            await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified", { pushToStack: true });
        }).row();
    }
    if (candidates.length === 0) {
        range.text("No one waiting! 🎉", (ctx) => ctx.answerCallbackQuery().catch(() => { })).row();
    }
    range.text(STAFF_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "🚀 <b>Final Step Pipeline</b>", "hr-final-step-menu");
    });
});

// --- UNIFIED CANDIDATE DETAILS ---
hrCandidateUnifiedMenu.dynamic(async (ctx, range) => {
    const candId = ctx.session.candidateData?.id;
    const slotId = ctx.session.selectedSlotId;
    if (!candId) return;
    ctx.session.candidateProfileMenuId = "hr-candidate-unified";
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
                    } catch (e) { logger.warn({ err: e, telegramId: result.telegramId }, "Could not send interview-conducted msg to candidate"); }
                }
                await ctx.answerCallbackQuery("Status: CONDUCTED").catch(() => { });
                await ctx.menu.update();
            }).row();
            range.text("🚫 No-show", async (ctx) => {
                await hrService.markNoShow(cand.id);
                const tid = Number(cand.user.telegramId);
                try {
                    const msg = await ctx.api.sendMessage(tid, (STAFF_TEXTS as any)["hr-rejection-noshow"]);
                    await trackUserMessage(tid, msg.message_id);
                } catch (e) { logger.warn({ err: e, tid }, "Could not send no-show rejection to candidate"); }
                await ctx.answerCallbackQuery("Status: NO-SHOW").catch(() => { });
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
                } catch (e) { logger.warn({ err: e, tid }, "Could not send reschedule msg to candidate"); }
                await ctx.answerCallbackQuery("Status: RESCHEDULE").catch(() => { });
                await ctx.menu.update();
            }).row();
        }
    }

    // 2. RECRUITMENT ACTIONS
    if (["SCREENING", "WAITLIST", "WAITLIST_HR"].includes(cStatus)) {
        range.text(cand.notificationSent ? "🔔 Remind" : STAFF_TEXTS["hr-btn-invite-individual"], async (ctx) => {
            const result = await hrService.inviteCandidate(ctx.api, cand.id);
            if (result.ok) {
                await ctx.answerCallbackQuery("Sent! ✅").catch(() => { });
            } else if (result.reason === "bot_blocked") {
                await ctx.answerCallbackQuery("Candidate blocked the bot.").catch(() => { });
            } else if (result.reason === "age_ineligible") {
                await ctx.answerCallbackQuery("Candidate no longer meets age requirements.").catch(() => { });
            } else if (result.reason === "gender_ineligible") {
                await ctx.answerCallbackQuery("Candidate does not meet gender requirements.").catch(() => { });
            } else {
                await ctx.answerCallbackQuery("Invite failed.").catch(() => { });
            }
            await ctx.menu.update();
        }).row();
    }

    if (cStatus === "MANUAL_REVIEW") {
        range.text("✅ Approve Tattoo", async (ctx) => {
            await hrService.approveTattoo(ctx.api, cand.id);
            await ctx.answerCallbackQuery("Approved! ✅").catch(() => { });
            await ctx.menu.update();
        });
        range.text("❌ Reject", async (ctx) => {
            await hrService.rejectCandidate(ctx.api, cand.id, "APPEARANCE");
            await ctx.answerCallbackQuery("Rejected ❌").catch(() => { });
            await ctx.menu.update();
        }).row();
    }

    if (["INTERVIEW_COMPLETED", "DECISION_PENDING"].includes(cStatus) && !hrDec) {
        range.text(STAFF_TEXTS["hr-btn-accept-offer"], async (ctx) => {
            await hrService.makeDecision(ctx.api, cand.id, "ACCEPTED", ctx.from?.id.toString());
            await ctx.answerCallbackQuery("Accepted! ✅").catch(() => { });
            await ctx.menu.update();
        });
        range.text(STAFF_TEXTS["hr-btn-reject"], async (ctx) => {
            await hrService.makeDecision(ctx.api, cand.id, "REJECTED", ctx.from?.id.toString());
            await ctx.answerCallbackQuery("Rejected ❌").catch(() => { });
            await ctx.menu.update();
        }).row();

        range.text(STAFF_TEXTS["hr-btn-change-location"], async (ctx) => {
            ctx.session.selectedCandidateId = cand.id;
            await ScreenManager.renderScreen(ctx, "📍 <b>Select new location:</b>", "hr-change-location-unified", { pushToStack: true });
        }).row();

        range.text(STAFF_TEXTS["hr-btn-reschedule"], async (ctx) => {
            await hrService.rescheduleCandidate(cand.id);
            const tid = Number(cand.user.telegramId);
            try {
                const msg = await ctx.api.sendMessage(tid, (STAFF_TEXTS as any)["hr-msg-reschedule"], {
                    reply_markup: new InlineKeyboard().text("🗓️ Обрати інший час", "start_scheduling")
                });
                await trackUserMessage(tid, msg.message_id);
            } catch (e) { logger.warn({ err: e, tid }, "Could not send reschedule msg to candidate"); }
            await ctx.answerCallbackQuery("Status: RESCHEDULE").catch(() => { });
            await ctx.menu.update();
        }).row();
    }
    const uRole = ctx.from?.id ? await getUserAdminRole(BigInt(ctx.from.id)) : null;

    // 2.2 MENTOR ACTIONS (Discovery & Training)
    const isMentor = uRole === 'SUPER_ADMIN' || uRole === 'MENTOR_LEAD';
    if (isMentor) {
        if (cStatus === "DISCOVERY_SCHEDULED") {
            range.text("✅ Discovery Passed", async (ctx) => {
                delete ctx.session.adminFlow;
                await ctx.answerCallbackQuery().catch(() => { });
                const { mentorService } = await import("../services/mentor-service.js");
                const res = await mentorService.completeDiscovery(ctx.api, cand.id, 'passed');
                if (res) {
                    await ScreenManager.renderScreen(ctx, `✨ <b>Discovery Passed!</b>\n\nNow please select the <b>Online Internship Date</b> for ${res.candidate.fullName}:`, "mentor-manual-date", { pushToStack: true });
                }
            }).text("❌ Failed", async (ctx) => {
                await ctx.answerCallbackQuery().catch(() => { });
                const { mentorService } = await import("../services/mentor-service.js");
                await mentorService.completeDiscovery(ctx.api, cand.id, 'failed');
                await ctx.menu.update();
            }).row();
        }

        if (cStatus === "DISCOVERY_COMPLETED") {
            range.text("🗓 Assign Online Internship", async (ctx) => {
                delete ctx.session.adminFlow;
                await ScreenManager.renderScreen(ctx, `🗓 <b>Assign Online Internship</b>\n\nPlease select the date for ${cand.fullName}:`, "mentor-manual-date", { pushToStack: true });
            }).row();
        }

        if (cStatus === "TRAINING_SCHEDULED") {
            range.text("✅ Training Completed", async (ctx) => {
                await ctx.answerCallbackQuery().catch(() => { });
                const { mentorService } = await import("../services/mentor-service.js");
                await mentorService.completeTraining(ctx.api, cand.id, 'passed');
                await ctx.menu.update();
            }).text("❌ Failed", async (ctx) => {
                await ctx.answerCallbackQuery().catch(() => { });
                const { mentorService } = await import("../services/mentor-service.js");
                await mentorService.completeTraining(ctx.api, cand.id, 'failed');
                await ctx.menu.update();
            }).row();
        }
    }

    // 2.5 FINAL STEP ACTIONS (SUPER_ADMIN ONLY)
    const isSuperAdmin = uRole === 'SUPER_ADMIN';

    if (isSuperAdmin) {
        // --- NDA & TEST REMINDERS ---
        if (cStatus === "NDA") {
            range.text("🔔 Ping NDA", async (ctx) => {
                await hrService.pingNDA(ctx.api, cand.id);
                await ctx.answerCallbackQuery("Ping sent! 🔔").catch(() => { });
            }).row();
        }

        if (cStatus === "KNOWLEDGE_TEST") {
            range.text("🔔 Ping Test", async (ctx) => {
                await hrService.pingTest(ctx.api, cand.id);
                await ctx.answerCallbackQuery("Ping sent! 🔔").catch(() => { });
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
                await ctx.answerCallbackQuery().catch(() => { });
                const { ADMIN_TEXTS } = await import("../constants/admin-texts.js");
                await ctx.reply(ADMIN_TEXTS["admin-staging-ask-date"] + "\nExample: 25.02.2026");
            });
            range.text(hasTime ? `⏰ ${cand.firstShiftTime}` : "⏰ Set Time", async (ctx) => {
                ctx.session.selectedCandidateId = cand.id;
                ctx.session.step = `set_staging_time_${cand.id}`;
                await ctx.answerCallbackQuery().catch(() => { });
                await ctx.reply("✍️ <b>Enter staging time:</b>\nExample: 10:00-12:00", { parse_mode: "HTML", reply_markup: { force_reply: true } });
            }).row();
            range.text(hasLoc ? `📍 ${formatLocation(cand.location, "in-city")}` : "📍 Set Loc", async (ctx) => {
                ctx.session.selectedCandidateId = cand.id;
                await ScreenManager.renderScreen(ctx, "📍 <b>Select new staging location:</b>", "hr-change-location-unified", { pushToStack: true });
            });
            range.text(hasPartner ? `📸 ${formatCompactName(cand.firstShiftPartner?.fullName)}` : "📸 Set Partner", async (ctx) => {
                if (!hasDate || !hasLoc) {
                    return ctx.answerCallbackQuery("⚠️ Please set date and location first!").catch(() => { });
                }
                ctx.session.selectedCandidateId = cand.id;
                await ScreenManager.renderScreen(ctx, "🔍 <b>Select a partner:</b>", "hr-staging-confirm", { pushToStack: true });
            }).row();

            // Action Button: Only active when ready (Simplified)
            if (hasDate && hasPartner && hasLoc) {
                range.text("🚀 Notify & Send to Staging", async (ctx) => {
                    ctx.session.selectedCandidateId = cand.id;
                    const result = await hrService.sendStagingNotifications(ctx.api, cand.id);
                    if (result && 'error' in result) {
                        await ctx.answerCallbackQuery(`❌ ${result.error}`).catch(() => { });
                    } else if (result) {
                        const candStatus = result.candidateNotified ? "✅" : "❌";
                        const partnerStatus = result.partnerNotified ? "✅" : "❌";
                        const confirmText = `📬 <b>Notifications sent!</b>\n\n` +
                            `👤 Candidate ${result.candName}: ${candStatus}\n` +
                            `📸 Partner ${result.partnerName}: ${partnerStatus}\n\n` +
                            `Status → <b>Active Staging</b>`;
                        await ctx.answerCallbackQuery("Notifications sent! ✅").catch(() => { });
                        await ScreenManager.renderScreen(ctx, confirmText, new InlineKeyboard().text("🚀 Final Step Pipeline", "nav_final_step_pipeline"));
                    } else {
                        await ctx.answerCallbackQuery("Error! Check details. ❌").catch(() => { });
                    }
                }).row();
            }

            range.text("🚫 Withdraw & Reject", async (ctx) => {
                await ctx.answerCallbackQuery().catch(() => { });
                const confirmText = `⚠️ <b>Confirm Rejection</b>\n\n` +
                    `You are about to mark this candidate as <b>REJECTED</b> because she withdrew during offline staging.\n\n` +
                    `After confirmation, we will:\n` +
                    `• remove her from staging\n` +
                    `• notify the assigned partner\n` +
                    `• close her application`;
                const kb = new InlineKeyboard()
                    .text("🚫 Yes, Reject", buildSignedCallback("hwr", cand.id)).row()
                    .text("⬅️ Back", "hr_cancel_withdraw_reject");
                await ScreenManager.renderScreen(ctx, confirmText, kb, { pushToStack: true });
            }).row();
        }

        // --- ACTIVE STAGING (Former OFFLINE_STAGING with notificationSent=true) ---
        if (cStatus === "STAGING_ACTIVE") {
            range.text("✅ Pass Staging", async (ctx) => {
                const res = await hrService.completeOfflineStaging(cand.id, true);
                if (res) {
                    const firstName = extractFirstName(res.candidate.fullName || "");
                    await ctx.api.sendMessage(Number(res.candidate.user.telegramId), CANDIDATE_TEXTS["admin-staging-passed-activation"](firstName), { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✨ Активувати профіль", `start_onboarding_data`) });
                    await ctx.answerCallbackQuery("Passed! ✅").catch(() => { });
                    await ctx.menu.update();
                }
            });
            range.text("❌ Fail", async (ctx) => {
                await hrService.completeOfflineStaging(cand.id, false);
                await ctx.answerCallbackQuery("Failed. ❌").catch(() => { });
                await ctx.menu.update();
            }).row();

            range.text("🔄 Reset to Setup", async (ctx) => {
                await candidateRepository.update(cand.id, { status: "STAGING_SETUP" as any, notificationSent: false, stagingNotifiedAt: null });
                await ctx.answerCallbackQuery("Reset to setup mode 🛠").catch(() => { });
                await ctx.menu.update();
            }).row();

            range.text("🚫 Withdraw & Reject", async (ctx) => {
                await ctx.answerCallbackQuery().catch(() => { });
                const confirmText = `⚠️ <b>Confirm Rejection</b>\n\n` +
                    `You are about to mark this candidate as <b>REJECTED</b> because she withdrew during offline staging.\n\n` +
                    `After confirmation, we will:\n` +
                    `• remove her from staging\n` +
                    `• notify the assigned partner\n` +
                    `• close her application`;
                const kb = new InlineKeyboard()
                    .text("🚫 Yes, Reject", buildSignedCallback("hwr", cand.id)).row()
                    .text("⬅️ Back", "hr_cancel_withdraw_reject");
                await ScreenManager.renderScreen(ctx, confirmText, kb, { pushToStack: true });
            }).row();
        }

    }

    // 3. CORE ACTIONS
    range.text(STAFF_TEXTS["hr-btn-write-message"], async (ctx) => {
        const userId = cand.user?.telegramId;
        if (userId) {
            await ctx.reply(STAFF_TEXTS["hr-ask-reply"]({ userId: userId.toString() }));
            ctx.session.step = `admin_reply_${userId}`;
            await ctx.answerCallbackQuery("✓").catch(() => { });
        }
    }).row();

    if (cand.hasUnreadMessage && ctx.session.viewingFromInbox) {
        range.text("👁️ Mark as Read", async (ctx) => {
            await candidateRepository.update(cand.id, { hasUnreadMessage: false });
            await ctx.answerCallbackQuery("Marked as read! ✅").catch(() => { });
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
        range.text(`${isCurrent ? '✅ ' : ''}${formatLocation(loc, "in-city")}`, async (ctx) => {
            if (isCurrent) return ctx.answerCallbackQuery("Already here.").catch(() => { });
            await candidateRepository.update(cand.id, { location: { connect: { id: loc.id } } } as any);
            await ctx.answerCallbackQuery(`Moved! ✅`).catch(() => { });

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
                await ctx.answerCallbackQuery(`Partner: ${shortenName(member.fullName)} ✅`).catch(() => { });
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
// hrFinalStepMenu itself is registered under the admin tree's recruitmentOpsMenu
// by src/handlers/admin/bootstrap.ts. This only wires up its own children plus the
// shared candidate-detail submenus.
hrCandidateUnifiedMenu.register(hrChangeLocationUnifiedMenu);
hrCandidateUnifiedMenu.register(hrStagingConfirmMenu);

hrFinalStepMenu.register(hrFinalStepNDAMenu);
hrFinalStepMenu.register(hrFinalStepTestMenu);
hrFinalStepMenu.register(hrFinalStepSetupMenu);
hrFinalStepMenu.register(hrFinalStepActiveMenu);
hrFinalStepMenu.register(hrFinalStepFillingMenu);
hrFinalStepMenu.register(hrFinalStepScheduleMenu);
