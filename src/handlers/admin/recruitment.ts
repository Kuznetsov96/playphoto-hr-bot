import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { STAFF_TEXTS } from "../../constants/staff-texts.js";
import { Menu } from "@grammyjs/menu";
import { Composer, InlineKeyboard } from "grammy";
import { CandidateStatus, FunnelStep, type StaffProfile } from "@prisma/client";
import type { MyContext } from "../../types/context.js";
import { getUserAdminRole } from "../../middleware/role-check.js";
import { candidateRepository } from "../../repositories/candidate-repository.js";
import { staffRepository } from "../../repositories/staff-repository.js";
import { locationRepository } from "../../repositories/location-repository.js";
import { startAdminSearch } from "./search.js";
import { formatCandidateProfile } from "../../utils/profile-formatter.js";
import { formatCompactName, extractFirstName, shortenName } from "../../utils/string-utils.js";
import { getCityCode, getShortLocationName } from "../../utils/location-helpers.js";
import { CANDIDATE_TEXTS } from "../../constants/candidate-texts.js";
import { statsService } from "../../services/stats-service.js";
import { hrService } from "../../services/hr-service.js";
import { createKyivDate } from "../../utils/bot-utils.js";
import logger from "../../core/logger.js";
import { ScreenManager } from "../../utils/screen-manager.js";


export const adminRecruitmentHandlers = new Composer<MyContext>();

export const adminOpsMenu = new Menu<MyContext>("admin-ops");
export const adminOfflineStagingMenu = new Menu<MyContext>("admin-offline-staging");
export const adminNDAMenu = new Menu<MyContext>("admin-nda-tracking");
export const adminCandidateMenu = new Menu<MyContext>("admin-candidate-details");
export const adminFirstShiftStaffMenu = new Menu<MyContext>("admin-first-shift-staff");
export const adminStagingSelectLocMenu = new Menu<MyContext>("admin-staging-select-loc");

adminOpsMenu.dynamic(async (ctx, range) => {
    const telegramId = ctx.from?.id;
    const userRole = telegramId ? await getUserAdminRole(BigInt(telegramId)) : null;
    const isSuperAdmin = userRole === 'SUPER_ADMIN';

    range.text(ADMIN_TEXTS["admin-ops-search"], async (ctx) => {
        await startAdminSearch(ctx);
    }).row();

    range.text(ADMIN_TEXTS["admin-ops-locations"], async (ctx) => {
        await ScreenManager.renderScreen(ctx, "🏙️ <b>Select City:</b>", "admin-cities", { pushToStack: true });
    }).row();

    if (isSuperAdmin) {
        const finalStats = await hrService.getFinalStepStats();
        range.text(STAFF_TEXTS["hr-menu-final-setup"]({ count: finalStats.total }), async (ctx) => {
            await ScreenManager.renderScreen(ctx, "🚀 <b>Final Step Pipeline</b>", "hr-final-step-menu", { pushToStack: true });
        }).row();
    }

    if (isSuperAdmin) {
        range.text(ADMIN_TEXTS["admin-ops-stats"], async (ctx) => {
            await ctx.answerCallbackQuery();
            const city = ctx.session.broadcastCity;
            const locationId = ctx.session.broadcastLocationId;
            const locationName = ctx.session.broadcastLocationName;
            const [stats, weeklyNew] = await Promise.all([
                statsService.getCandidateFunnelStats(city, locationId),
                statsService.getWeeklyNewCount(city, locationId)
            ]);
            const text = statsService.formatFunnelDashboard(stats, weeklyNew, city, locationName);
            await ScreenManager.renderScreen(ctx, text, "admin-stats", { pushToStack: true });
        }).row();
    }

    range.text(ADMIN_TEXTS["hr-menu-back"], async (ctx) => {
        const { staffService } = await import("../../modules/staff/services/index.js");
        const userRole = await getUserAdminRole(BigInt(ctx.from!.id));
        const text = await staffService.getAdminHeader(userRole as any);
        await ScreenManager.goBack(ctx, text, "admin-main");
    });
});

adminOfflineStagingMenu.dynamic(async (ctx, range) => {
    const candidates = await candidateRepository.findOfflineStagingUnassigned();

    if (candidates.length === 0) {
        range.text(ADMIN_TEXTS["admin-staging-none"], (ctx) => { }).row();
    } else {
        for (const cand of candidates) {
            const label = `📸 ${formatCompactName(cand.fullName)} • [${getCityCode(cand.city)}] ${getShortLocationName(cand.location?.name, cand.city)}`;
            range.text(label, async (ctx) => {
                if (!ctx.session.candidateData) ctx.session.candidateData = {} as any;
                ctx.session.selectedCandidateId = cand.id;

                const text = await formatCandidateProfile(ctx as any, cand as any, {
                    includeActionLabel: true,
                    actionLabel: ADMIN_TEXTS["support-panel-action"]
                });

                await ScreenManager.renderScreen(ctx, text, "admin-candidate-details", { pushToStack: true });
            }).row();
        }
    }

    range.text(ADMIN_TEXTS["hr-menu-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "🛠️ <b>HR Operations</b>", "admin-ops");
    });
});

adminCandidateMenu.dynamic(async (ctx, range) => {
    const candId = ctx.session.selectedCandidateId;
    if (!candId) return;

    const cand = await candidateRepository.findById(candId);
    if (!cand) return;

    const userRole = ctx.from?.id ? await getUserAdminRole(BigInt(ctx.from.id)) : null;
    const isHr = userRole === 'SUPER_ADMIN' || userRole === 'CO_FOUNDER' || userRole === 'HR_LEAD';
    const isMentor = userRole === 'SUPER_ADMIN' || userRole === 'MENTOR_LEAD';
    const isSuper = userRole === 'SUPER_ADMIN' || userRole === 'CO_FOUNDER';

    // 1. PRIMARY ACTION
    if (isMentor && cand.status === "DISCOVERY_SCHEDULED") {
        range.text("✅ Discovery Passed", async (ctx) => {
            delete ctx.session.adminFlow;
            await ctx.answerCallbackQuery();
            const { mentorService } = await import("../../services/mentor-service.js");
            const res = await mentorService.completeDiscovery(ctx.api, cand.id, 'passed');
            if (res) {
                await ScreenManager.renderScreen(ctx, `✨ <b>Discovery Passed!</b>\n\nNow please select the <b>Online Internship Date</b> for ${res.candidate.fullName}:`, "mentor-manual-date", { pushToStack: true });
            }
        }).text(ADMIN_TEXTS["admin-btn-fail"], async (ctx) => {
            await ctx.answerCallbackQuery();
            const { mentorService } = await import("../../services/mentor-service.js");
            await mentorService.completeDiscovery(ctx.api, cand.id, 'failed');
            await ctx.menu.update();
        }).row();
    }

    if (isMentor && cand.status === "DISCOVERY_COMPLETED") {
        range.text("🗓 Assign Online Internship", async (ctx) => {
            delete ctx.session.adminFlow;
            await ScreenManager.renderScreen(ctx, `🗓 <b>Assign Online Internship</b>\n\nPlease select the date for ${cand.fullName}:`, "mentor-manual-date", { pushToStack: true });
        }).row();
    }

    if (isMentor && cand.status === "TRAINING_SCHEDULED") {
        range.text("✅ Training Completed", async (ctx) => {
            await ctx.answerCallbackQuery();
            const { mentorService } = await import("../../services/mentor-service.js");
            await mentorService.completeTraining(ctx.api, cand.id, 'passed');
            await ctx.menu.update();
        }).text(ADMIN_TEXTS["admin-btn-fail"], async (ctx) => {
            await ctx.answerCallbackQuery();
            const { mentorService } = await import("../../services/mentor-service.js");
            await mentorService.completeTraining(ctx.api, cand.id, 'failed');
            await ctx.menu.update();
        }).row();
    }

    if (isHr && ["SCREENING", "WAITLIST"].includes(cand.status)) {
        range.text("🗓️ Re-invite to Interview", async (ctx) => {
            const { hrService } = await import("../../services/hr-service.js");
            await hrService.markAsScreening(candId);
            await ctx.answerCallbackQuery("Status reset. Sending invite...");
            await ctx.api.sendMessage(Number(cand.user.telegramId),
                CANDIDATE_TEXTS["admin-re-invite-interview"],
                { reply_markup: new InlineKeyboard().text("🗓️ Обрати час", "start_scheduling") }
            );
            await ctx.menu.update();
        }).row();
    }

    if (isMentor && ["TRAINING_COMPLETED", "WAITLIST"].includes(cand.status) && cand.quizScore !== null) {
        range.text("🎓 Re-invite to Training", async (ctx) => {
            await ctx.answerCallbackQuery("Sending training slots...");
            await ctx.api.sendMessage(Number(cand.user.telegramId),
                CANDIDATE_TEXTS["admin-re-invite-training"],
                { reply_markup: new InlineKeyboard().text("🎓 Обрати час", "start_training_scheduling") }
            );
        }).row();
    }

    const isReadyForStaging = !!(cand.firstShiftDate && cand.locationId && cand.firstShiftPartnerId);
    const isStagingStatus = cand.status === CandidateStatus.OFFLINE_STAGING || cand.status === CandidateStatus.AWAITING_FIRST_SHIFT;

    if (isSuper && isReadyForStaging && (cand.status === CandidateStatus.TRAINING_COMPLETED || cand.status === CandidateStatus.OFFLINE_STAGING) && !cand.notificationSent) {
        range.text("🚀 Confirm & Notify Staging", async (ctx) => {
            const { hrService } = await import("../../services/hr-service.js");
            const result = await hrService.sendStagingNotifications(ctx.api, cand.id);
            if (result && 'error' in result) {
                await ctx.answerCallbackQuery(`❌ ${result.error}`);
            } else if (result) {
                await ctx.answerCallbackQuery("Success! Candidate and partner notified. ✅");
                await ctx.menu.update();
            } else {
                await ctx.answerCallbackQuery("Error sending notifications ❌");
            }
        }).row();
    }

    if (isMentor && cand.status === CandidateStatus.OFFLINE_STAGING && cand.notificationSent) {
        range.text("✅ Pass Staging", async (ctx) => {
            const { hrService } = await import("../../services/hr-service.js");
            const res = await hrService.completeOfflineStaging(cand.id, true);
            if (res) {
                const firstName = extractFirstName(res.candidate.fullName || "");
                await ctx.api.sendMessage(Number(res.candidate.user.telegramId), CANDIDATE_TEXTS["admin-staging-passed-activation"](firstName), { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✨ Активувати профіль", `start_onboarding_data`) });
                await ctx.answerCallbackQuery("Passed! ✅");
                await ctx.menu.update();
            }
        });
        range.text("❌ Fail", async (ctx) => {
            const { hrService } = await import("../../services/hr-service.js");
            await hrService.completeOfflineStaging(cand.id, false);
            await ctx.answerCallbackQuery("Failed. ❌");
            await ctx.menu.update();
        }).row();
    }

    if (isSuper && (cand.status === CandidateStatus.TRAINING_COMPLETED || (cand.status as string) === "NDA") && !cand.ndaConfirmedAt) {
        range.text("🔔 Ping NDA", async (ctx) => {
            const { NDA_LINK } = await import("../../config.js");
            const firstName = extractFirstName(cand.fullName || "");
            const kb = new InlineKeyboard().text("✅ Ознайомлена з NDA", `confirm_nda_${cand.id}`);

            try {
                await ctx.api.sendMessage(Number(cand.user.telegramId),
                    CANDIDATE_TEXTS["nda-reminder"](firstName, NDA_LINK),
                    { parse_mode: "HTML", reply_markup: kb }
                );
                await ctx.answerCallbackQuery("Ping sent! 🔔");
            } catch (e) {
                await ctx.answerCallbackQuery("Error sending ping ❌");
            }
        }).row();
    }

    range.text("✉️ Write Message", async (ctx) => {
        const { startAdminMessageFlow } = await import("./search.js");
        await startAdminMessageFlow(ctx, cand.user.id);
    }).row();

    const canEditStaging = isMentor && (cand.status === "OFFLINE_STAGING" || cand.status === "AWAITING_FIRST_SHIFT");
    if (canEditStaging || isSuper) {
        range.text(canEditStaging ? "🛠 Edit Staging..." : "🛠 More Actions...", async (ctx) => {
            await ctx.answerCallbackQuery();
            let text = `<b>${canEditStaging ? "Edit Staging Details" : "Additional Actions"}:</b>\n\n` +
                (canEditStaging ? `• Change Date, Time or Location for the test shift.\n` : "") +
                (isSuper ? `• View Chat History or Reset Candidate.` : "");
            const kb = new InlineKeyboard();
            if (canEditStaging) {
                kb.text("📅 Change Date", `admin_change_staging_date_${candId}`).row();
                kb.text("📍 Change Location", `admin_change_staging_loc_${candId}`).row();
                kb.text("⏰ Change Time", `admin_change_staging_time_${candId}`).row();
            }
            if (isSuper) kb.text("📋 Chat History", `admin_timeline_export_${cand.user.id}`).row();
            kb.text("⬅️ Back to Profile", `view_candidate_${candId}`);
            await ScreenManager.renderScreen(ctx, text, kb);
        }).row();
    }

    range.text(ADMIN_TEXTS["hr-menu-back"], async (ctx) => {
        delete ctx.session.stagingLocationId;
        delete ctx.session.stagingTime;
        await ScreenManager.goBack(ctx, "🛠️ <b>HR Operations</b>", "admin-ops");
    });
});

adminStagingSelectLocMenu.dynamic(async (ctx, range) => {
    const candId = ctx.session.selectedCandidateId;
    if (!candId) return;
    const cand = await candidateRepository.findById(candId);
    if (!cand?.city) return;
    const locations = await locationRepository.findByCity(cand.city);
    for (const loc of locations) {
        range.text(`${loc.name}`, async (ctx) => {
            ctx.session.stagingLocationId = loc.id;
            await ScreenManager.goBack(ctx, "👤 <b>Candidate Details</b>", "admin-candidate-details");
        }).row();
    }
    range.text(ADMIN_TEXTS["admin-staging-back-btn"], (ctx) => ScreenManager.goBack(ctx, "👤 <b>Candidate Details</b>", "admin-candidate-details"));
});

adminFirstShiftStaffMenu.dynamic(async (ctx, range) => {
    const candId = ctx.session.selectedCandidateId;
    if (!candId) return;
    const stagingLocId = ctx.session.stagingLocationId;
    if (!stagingLocId) return;
    const cand = await candidateRepository.findById(candId);
    if (!cand) return;

    let staff: StaffProfile[] = [];
    let isFilteredBySchedule = false;

    logger.debug({
        candId,
        stagingLocId,
        firstShiftDate: cand.firstShiftDate
    }, "Partner menu initialization");

    if (cand.firstShiftDate) {
        // Find ONLY staff who have a shift at this location on this day
        staff = await staffRepository.findWithShiftAtLocation(stagingLocId, cand.firstShiftDate);
        isFilteredBySchedule = true;
        logger.debug({ foundCount: staff.length }, "Partner lookup (ONLY schedule)");
    } else {
        // Fallback: show all active staff for this location if date not set
        staff = await staffRepository.findByLocation(stagingLocId);
        logger.debug({ foundCount: staff.length }, "Partner lookup (FALLBACK to location)");
    }

    if (staff.length === 0) {
        // If no one found — show clear warning
        range.text(isFilteredBySchedule ? ADMIN_TEXTS["admin-shifts-none"] : ADMIN_TEXTS["admin-staging-partner-none"], (ctx) => { }).row();
    } else {
        if (isFilteredBySchedule) {
            range.text(ADMIN_TEXTS["admin-staging-partner-active-title"]).row();
        }

        for (const member of staff) {
            const displayPartnerName = shortenName(member.fullName);
            range.text(`📷 ${displayPartnerName}`, async (ctx) => {
                const candId = ctx.session.selectedCandidateId;
                if (!candId) return;

                const stagingTime = ctx.session.stagingTime || "15:00-17:00";

                await candidateRepository.update(candId, {
                    firstShiftPartner: { connect: { id: member.id } },
                    firstShiftTime: stagingTime,
                    location: { connect: { id: stagingLocId } },
                    notificationSent: false
                });

                await ctx.answerCallbackQuery(`✅ Partner selected: ${displayPartnerName}`);
                await ScreenManager.renderScreen(ctx, "👤 <b>Candidate Details</b>", "admin-candidate-details");

                delete ctx.session.stagingLocationId;
                delete ctx.session.stagingTime;
            }).row();
        }
    }

    range.row().text("🔄 Refresh List", async (ctx) => {
        await ctx.answerCallbackQuery("Refreshing photographers...");
        await ctx.menu.update();
    });

    range.text(ADMIN_TEXTS["hr-menu-back"], (ctx) => ScreenManager.goBack(ctx, "👤 <b>Candidate Details</b>", "admin-candidate-details"));
});

adminNDAMenu.dynamic(async (ctx, range) => {
    const candidates = await candidateRepository.findAwaitingNDA();

    if (candidates.length === 0) {
        range.text("All NDAs confirmed! ✅", (ctx) => { }).row();
    } else {
        const now = new Date();
        for (const cand of candidates) {
            const sentAt = cand.ndaSentAt || (cand as any).updatedAt;
            const hoursWaiting = Math.floor((now.getTime() - new Date(sentAt).getTime()) / (1000 * 60 * 60));
            const label = `📋 ${formatCompactName(cand.fullName)} • ${hoursWaiting}h`;

            range.text(label, async (ctx) => {
                ctx.session.selectedCandidateId = cand.id;
                const text = await formatCandidateProfile(ctx as any, cand as any, {
                    includeActionLabel: true,
                    includeHistory: true,
                    viewerRole: "HR"
                });
                await ScreenManager.renderScreen(ctx, text, "admin-candidate-details", { pushToStack: true });
            }).row();
        }
    }
    range.text(ADMIN_TEXTS["hr-menu-back"], (ctx) => ScreenManager.goBack(ctx, "🛠️ <b>HR Operations</b>", "admin-ops"));
});

adminRecruitmentHandlers.callbackQuery("admin_staging_ready_nda", async (ctx: MyContext) => {
    const candidates = await candidateRepository.findByStatusWithUser(CandidateStatus.TRAINING_COMPLETED, {
        ndaConfirmedAt: { not: null }
    });

    if (candidates.length === 0) {
        return ctx.answerCallbackQuery("No candidates waiting.");
    }

    let text = `✅ <b>Ready for Staging (NDA Signed)</b>\n\nSelect a candidate to proceed:`;
    const kb = new InlineKeyboard();
    for (const cand of candidates) {
        kb.text(`👤 ${formatCompactName(cand.fullName)}`, `view_candidate_${cand.id}`).row();
    }
    kb.text(ADMIN_TEXTS["hr-menu-back"], "admin-ops");

    await ScreenManager.renderScreen(ctx, text, kb);
});

adminRecruitmentHandlers.callbackQuery("admin_staging_unassigned", async (ctx: MyContext) => {
    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-staging-select-loc-filter-hint"], "admin-offline-staging", { pushToStack: true });
});

adminRecruitmentHandlers.callbackQuery("admin_staging_active", async (ctx: MyContext) => {
    const candidates = await candidateRepository.findByStatusWithUser(CandidateStatus.OFFLINE_STAGING, { firstShiftPartnerId: { not: null }, currentStep: FunnelStep.FIRST_SHIFT });
    const kb = new InlineKeyboard();
    if (candidates.length === 0) kb.text(ADMIN_TEXTS["admin-staging-active-none"], "none").row();
    else {
        for (const cand of candidates) {
            const label = `👤 ${formatCompactName(cand.fullName)} • [${getCityCode(cand.city)}] ${getShortLocationName(cand.location?.name, cand.city)}`;
            kb.text(label, `admin_manage_active_${cand.id}`).row();
        }
    }
    kb.text(ADMIN_TEXTS["hr-menu-back"], "admin_ops_back");
    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-staging-header-active"], kb, { pushToStack: true });
});

adminRecruitmentHandlers.callbackQuery("admin_staging_ready", async (ctx: MyContext) => {
    // Only show candidates who are in status AWAITING_FIRST_SHIFT AND haven't received their welcome yet
    const candidates = await candidateRepository.findByStatusWithUser(CandidateStatus.AWAITING_FIRST_SHIFT, {
        currentStep: FunnelStep.FIRST_SHIFT,
        user: {
            staffProfile: {
                isWelcomeSent: false
            }
        }
    });

    const kb = new InlineKeyboard();
    if (candidates.length === 0) kb.text(ADMIN_TEXTS["admin-staging-ready-none"], "none").row();
    else {
        for (const cand of candidates) {
            const label = `👤 ${formatCompactName(cand.fullName)} • [${getCityCode(cand.city)}] ${getShortLocationName(cand.location?.name, cand.city)}`;
            kb.text(label, `admin_manage_ready_${cand.id}`).row();
        }
    }
    kb.text(ADMIN_TEXTS["hr-menu-back"], "admin_ops_back");
    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-staging-header-ready"], kb, { pushToStack: true });
});

adminRecruitmentHandlers.callbackQuery(/^admin_manage_active_(.+)$/, async (ctx: MyContext) => {
    const candId = ctx.match![1];
    const cand = await candidateRepository.findById(candId!);
    if (!cand) return;
    const text = `👤 <b>${cand.fullName}</b>\n` + ADMIN_TEXTS["admin-staging-card-location"]({ loc: cand.location?.name || "—" }) + "\n" + ADMIN_TEXTS["admin-staging-card-partner"]({ partner: shortenName(cand.firstShiftPartner?.fullName || "—") }) + "\n\n" + `<b>${ADMIN_TEXTS["admin-staging-card-result"]}</b> <i>Select outcome:</i>`;
    const kb = new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-pass"], `admin_staging_pass_${candId}`).text(ADMIN_TEXTS["admin-btn-fail"], `admin_staging_fail_${candId}`).row().text(ADMIN_TEXTS["admin-staging-back-btn"], "admin_staging_active");
    await ScreenManager.renderScreen(ctx, text, kb);
});

adminRecruitmentHandlers.callbackQuery(/^admin_staging_pass_(.+)$/, async (ctx: MyContext) => {
    const candId = ctx.match![1];
    const existingCand = await candidateRepository.findById(candId!);
    if (!existingCand || existingCand.status !== "OFFLINE_STAGING") return ctx.answerCallbackQuery(ADMIN_TEXTS["admin-ans-already-processing"]);
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });
    const { hrService } = await import("../../services/hr-service.js");
    const result = await hrService.completeOfflineStaging(candId!, true);
    if (result && result.passed) {
        const firstName = extractFirstName(result.candidate.fullName || "");
        await ctx.api.sendMessage(Number(result.candidate.user.telegramId), CANDIDATE_TEXTS["admin-staging-passed-activation"](firstName), { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✨ Активувати профіль", `start_onboarding_data`) });
        await ctx.answerCallbackQuery(ADMIN_TEXTS["admin-ans-success-notified"]);
        await ScreenManager.renderScreen(ctx, `✅ <b>Success!</b>\n\n<b>${shortenName(result.candidate.fullName || "Candidate")}</b> passed!`, new InlineKeyboard().text("📋 Ready for Schedule", "admin_staging_ready"));
    }
});

adminRecruitmentHandlers.callbackQuery(/^admin_staging_fail_(.+)$/, async (ctx: MyContext) => {
    const candId = ctx.match![1];
    const existingCand = await candidateRepository.findById(candId!);
    if (!existingCand || existingCand.status !== "OFFLINE_STAGING") return ctx.answerCallbackQuery(ADMIN_TEXTS["admin-ans-already-processing"]);
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });
    const { hrService } = await import("../../services/hr-service.js");
    const result = await hrService.completeOfflineStaging(candId!, false);
    if (result) {
        await ctx.answerCallbackQuery("Failed. ❌");
        await ScreenManager.renderScreen(ctx, `❌ <b>Staging Failed.</b>\n\n<b>${shortenName(result.candidate.fullName || "Candidate")}</b> did not pass.`, new InlineKeyboard().text("📋 Active Staging", "admin_staging_active"));
    }
});

adminRecruitmentHandlers.callbackQuery(/^admin_manage_ready_(.+)$/, async (ctx: MyContext) => {
    const candId = ctx.match![1];
    const cand = await candidateRepository.findById(candId!);
    if (!cand) return;
    const text = `👤 <b>${cand.fullName}</b>\n` + ADMIN_TEXTS["admin-staging-card-status-pass"] + "\n" + ADMIN_TEXTS["admin-staging-card-status-docs"] + "\n\n" + ADMIN_TEXTS["admin-staging-card-final-step"];
    const kb = new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-schedule-created"], `admin_hire_final_${candId}`).row().text(ADMIN_TEXTS["admin-staging-back-btn"], "admin_staging_ready");
    await ScreenManager.renderScreen(ctx, text, kb);
});

adminRecruitmentHandlers.callbackQuery(/^admin_hire_final_(.+)$/, async (ctx: MyContext) => {
    const candId = ctx.match![1];
    const { userRepository } = await import("../../repositories/user-repository.js");
    const { staffRepository } = await import("../../repositories/staff-repository.js");
    const { staffService } = await import("../../modules/staff/services/index.js");
    const { hrService } = await import("../../services/hr-service.js");

    const cand = await candidateRepository.findById(candId!);
    if (!cand || (cand.status !== "AWAITING_FIRST_SHIFT" && cand.status !== "HIRED")) return ctx.answerCallbackQuery(ADMIN_TEXTS["admin-ans-already-processing"]);

    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });

    // 1. Confirm schedule in sheets/DB
    const res = await hrService.confirmFinalSchedule(candId!);

    if (res) {
        const telegramId = BigInt(res.candidate.user.telegramId);
        let user = await userRepository.findWithStaffProfileByTelegramId(telegramId);

        // 2. Ensure staff profile exists
        if (user && !user.staffProfile) {
            const createData: any = { user: { connect: { id: user.id } }, fullName: res.candidate.fullName || "Фотограф", isActive: true };
            if (res.candidate.locationId) createData.location = { connect: { id: res.candidate.locationId } };
            await staffRepository.create(createData);
            user = await userRepository.findWithStaffProfileByTelegramId(telegramId);
        }

        // 3. Use Unified Activation (Sends correct Welcome message & marks as sent)
        if (user?.staffProfile) {
            await staffService.finalizeStaffActivation(user.staffProfile.id, ctx.api);
        }

        if (res.candidate) {
            const { MENTOR_IDS } = await import("../../config.js");
            const mentorMsg = ADMIN_TEXTS["admin-notif-new-onboarding"]({ name: res.candidate.fullName || "Candidate" });
            for (const mId of MENTOR_IDS) {
                await ctx.api.sendMessage(mId, mentorMsg, { parse_mode: "HTML" }).catch(() => { });
            }
        }
        await ctx.answerCallbackQuery(ADMIN_TEXTS["admin-ans-success-hired"]);
    }
    await ScreenManager.renderScreen(ctx, "🛠️ <b>HR Operations</b>", "admin-ops");
});

adminRecruitmentHandlers.callbackQuery(/^staging_(.+)_date_(.+)$/, async (ctx: MyContext) => {
    const candId = ctx.match![1];
    const dateStr = ctx.match![2];

    if (!candId || !dateStr) return;

    let date: Date;
    if (dateStr === "today") {
        date = new Date();
    } else if (dateStr === "tomorrow") {
        date = new Date();
        date.setDate(date.getDate() + 1);
    } else {
        date = new Date(dateStr);
    }

    // Set to noon to avoid timezone issues
    date.setHours(12, 0, 0, 0);

    // Preserve STAGING_SETUP/STAGING_ACTIVE status — only update the date
    const currentCand_d = await hrService.getCandidateDetails(candId);
    const currentStatus_d = currentCand_d?.status as string | undefined;
    const keepStatus_d = (currentStatus_d === "STAGING_SETUP" || currentStatus_d === "STAGING_ACTIVE")
        ? currentStatus_d
        : CandidateStatus.OFFLINE_STAGING;

    const updateData: any = {
        firstShiftDate: date,
        status: keepStatus_d as any,
        currentStep: FunnelStep.FIRST_SHIFT,
        notificationSent: false
    };
    // Auto-set default time if not already set
    if (!currentCand_d?.firstShiftTime) {
        updateData.firstShiftTime = "15:00-17:00";
    }
    await candidateRepository.update(candId, updateData);

    const updatedCand = await hrService.getCandidateDetails(candId);
    if (updatedCand) {
        const text = await formatCandidateProfile(ctx as any, updatedCand as any, { includeActionLabel: true });
        await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified");
    }

    await ctx.answerCallbackQuery(`Date set: ${date.toLocaleDateString('uk-UA')}`).catch(() => { });
});

adminRecruitmentHandlers.on("message:text", async (ctx, next) => {
    const step = ctx.session.step || "";
    if (step.startsWith("set_staging_time_")) {
        await ctx.deleteMessage().catch(() => { });
        const candId = step.replace("set_staging_time_", "");

        // Preserve STAGING_SETUP/STAGING_ACTIVE status — only update the time
        const currentCand_t = await hrService.getCandidateDetails(candId);
        const currentStatus_t = currentCand_t?.status as string | undefined;
        const keepStatus_t = (currentStatus_t === "STAGING_SETUP" || currentStatus_t === "STAGING_ACTIVE")
            ? currentStatus_t
            : CandidateStatus.OFFLINE_STAGING;

        await candidateRepository.update(candId, {
            firstShiftTime: ctx.message.text,
            status: keepStatus_t as any,
            currentStep: FunnelStep.FIRST_SHIFT,
            notificationSent: false
        });
        ctx.session.step = "idle";

        const updatedCand = await hrService.getCandidateDetails(candId);
        if (updatedCand) {
            const text = await formatCandidateProfile(ctx as any, updatedCand as any, { includeActionLabel: true });
            await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified");
        }
        // NOTE: No answerCallbackQuery — this is a message handler, not a callback
        return;
    }
    await next();
});

adminRecruitmentHandlers.callbackQuery(/^admin_set_default_time_(.+)$/, async (ctx: MyContext) => {
    const candId = ctx.match![1];
    ctx.session.stagingTime = "15:00-17:00";
    if (candId) ctx.session.selectedCandidateId = candId;
    await ScreenManager.renderScreen(ctx, "✅ Using default time 15:00-17:00. Select a partner:", "admin-first-shift-staff");
});

adminRecruitmentHandlers.callbackQuery(/^admin_change_staging_date_(.+)$/, async (ctx: MyContext) => {
    const candId = ctx.match![1];
    if (candId) ctx.session.selectedCandidateId = candId;
    ctx.session.step = `set_first_shift_date_${candId}`;
    await ctx.answerCallbackQuery();
    await ctx.reply(ADMIN_TEXTS["admin-staging-ask-date"] + "\nExample: 25.02.2026");
});

adminRecruitmentHandlers.callbackQuery(/^admin_change_staging_loc_(.+)$/, async (ctx: MyContext) => {
    const candId = ctx.match![1];
    if (candId) ctx.session.selectedCandidateId = candId;
    await ScreenManager.renderScreen(ctx, "📍 <b>Select new staging location:</b>", "admin-staging-select-loc", { pushToStack: true });
});

adminRecruitmentHandlers.callbackQuery(/^admin_change_staging_time_(.+)$/, async (ctx: MyContext) => {
    const candId = ctx.match![1];
    if (candId) ctx.session.selectedCandidateId = candId;
    ctx.session.step = `set_staging_time_${candId}`;
    await ctx.answerCallbackQuery();
    await ctx.reply("✍️ <b>Enter staging time:</b>\nExample: 10:00-12:00", { reply_markup: { force_reply: true } });
});

adminRecruitmentHandlers.callbackQuery("admin_ops_back", async (ctx: MyContext) => {
    await ScreenManager.renderScreen(ctx, "🛠️ <b>HR Operations</b>", "admin-ops");
});

adminRecruitmentHandlers.callbackQuery("admin-ops", async (ctx: MyContext) => {
    await ScreenManager.renderScreen(ctx, "🛠️ <b>HR Operations</b>", "admin-ops");
});
