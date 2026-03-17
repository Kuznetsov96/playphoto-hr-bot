import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { Menu } from "@grammyjs/menu";
import type { MyContext } from "../types/context.js";
import { mentorService } from "../services/mentor-service.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { InlineKeyboard, Composer } from "grammy";
import logger from "../core/logger.js";
import { menuRegistry } from "../utils/menu-registry.js";
import { formatCandidateProfile } from "../utils/profile-formatter.js";
import { formatCompactName } from "../utils/string-utils.js";
import { getCityCode, getShortLocationName } from "../utils/location-helpers.js";
import { ScreenManager } from "../utils/screen-manager.js";

// --- HELPERS ---
const formatDate = (date: Date) => {
    const d = date.getDate();
    const m = date.getMonth() + 1;
    const y = date.getFullYear();
    return `${d < 10 ? '0' + d : d}.${m < 10 ? '0' + m : m}.${y}`;
};

const getMentorCandidateProfileText = async (ctx: MyContext, candId: string) => {
    const details = await mentorService.getCandidateDetails(candId);
    if (!details || !details.cand) return "Candidate details not found. Please refresh /mentor.";
    
    return await formatCandidateProfile(ctx as any, details.cand as any, {
        includeHistory: true,
        viewerRole: "MENTOR"
    });
};

export const updateCalendarDashboard = async (ctx: MyContext) => {
    const today = new Date();
    const dateStr = formatDate(today);
    const slots = await mentorService.getTrainingSlots(dateStr);
    const booked = slots.filter((s: any) => s.isBooked);

    let text = `📅 <b>Calendar</b>\n\n`;
    text += `<b>Today (${dateStr}):</b> ${booked.length} meetings\n`;
    
    if (booked.length > 0) {
        booked.forEach((s: any) => {
            const time = s.startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
            const cand = s.candidate || s.candidateDiscovery;
            text += `• ${time} - ${cand?.fullName || 'Candidate'}\n`;
        });
    }
    
    text += `\nSelect a date to view or manage schedule:`;
    await ScreenManager.renderScreen(ctx, text, "mentor-training-dates", { pushToStack: true });
};

// --- MENUS (Declared first) ---
export const mentorRootMenu = new Menu<MyContext>("mentor-root");
menuRegistry.register(mentorRootMenu);
export const mentorHubMenu = new Menu<MyContext>("mentor-hub-menu");
menuRegistry.register(mentorHubMenu);
export const mentorInboxMenu = new Menu<MyContext>("mentor-inbox");
menuRegistry.register(mentorInboxMenu);
export const mentorMessagesMenu = new Menu<MyContext>("mentor-messages");
menuRegistry.register(mentorMessagesMenu);
export const mentorInboxDetailsMenu = new Menu<MyContext>("mentor-inbox-details");
menuRegistry.register(mentorInboxDetailsMenu);
export const mentorManualTrainingDateMenu = new Menu<MyContext>("mentor-manual-date");
menuRegistry.register(mentorManualTrainingDateMenu);
export const mentorManualTimeSelectionMenu = new Menu<MyContext>("mentor-manual-time-selection");
menuRegistry.register(mentorManualTimeSelectionMenu);
export const mentorManualTrainingTimeMenu = new Menu<MyContext>("mentor-manual-time");
menuRegistry.register(mentorManualTrainingTimeMenu);
export const mentorTrainingDatesMenu = new Menu<MyContext>("mentor-training-dates");
menuRegistry.register(mentorTrainingDatesMenu);
export const mentorTrainingDayViewMenu = new Menu<MyContext>("mentor-training-day-view");
menuRegistry.register(mentorTrainingDayViewMenu);
export const mentorOnboardingMenu = new Menu<MyContext>("mentor-onboarding");
menuRegistry.register(mentorOnboardingMenu);
export const mentorOnboardingDayMenu = new Menu<MyContext>("mentor-onboarding-day");
menuRegistry.register(mentorOnboardingDayMenu);
export const mentorOnboardingDetailsMenu = new Menu<MyContext>("mentor-onboarding-details");
menuRegistry.register(mentorOnboardingDetailsMenu);
export const mentorBroadcastCitiesMenu = new Menu<MyContext>("mentor-broadcast-cities");
menuRegistry.register(mentorBroadcastCitiesMenu);
export const mentorBroadcastCombinedConfirmMenu = new Menu<MyContext>("mentor-broadcast-combined-confirm");
menuRegistry.register(mentorBroadcastCombinedConfirmMenu);

export const mentorActionSuccessMenu = new Menu<MyContext>("mentor-action-success");
menuRegistry.register(mentorActionSuccessMenu);

mentorActionSuccessMenu.text("🏠 Back to Hub", async (ctx) => {
    await ScreenManager.renderScreen(ctx, await mentorService.getHubText(), "mentor-hub-menu");
});

// --- 1. MENTOR HUB ---
mentorHubMenu.dynamic(async (ctx, range) => {
    const stats = await mentorService.getStats();

    const totalInbox = stats.newAcceptedCount + stats.readyForTrainingCount + stats.waitlistCount + stats.unreadMessagesCount;
    const inboxLabel = `📥 Inbox${totalInbox > 0 ? ` ${totalInbox}` : ''}`;
    range.text(inboxLabel, async (ctx) => {
        ctx.session.filterWaitlist = false;
        await ScreenManager.renderScreen(ctx, "📥 <b>Inbox</b>", "mentor-inbox", { pushToStack: true });
    }).row();

    const calendarLabel = `📅 Calendar${stats.trainingToday > 0 ? ` ${stats.trainingToday}` : ''}`;
    range.text(calendarLabel, async (ctx) => {
        await updateCalendarDashboard(ctx);
    }).row();

    const onboardingLabel = `🚀 Onboarding${stats.onboardingCount > 0 ? ` ${stats.onboardingCount}` : ''}`;
    range.text(onboardingLabel, async (ctx) => {
        await ScreenManager.renderScreen(ctx, "🚀 <b>Onboarding</b>", "mentor-onboarding", { pushToStack: true });
    }).row();
});

// --- 2. INBOX ---
mentorInboxMenu.dynamic(async (ctx, range) => {
    const stats = await mentorService.getStats();
    const isWaitlist = ctx.session.filterWaitlist === true;
    
    if (isWaitlist) {
        range.text("🔔 Notify All Waitlist", async (ctx) => {
            const count = await mentorService.notifyWaitlist(ctx.api);
            await ctx.answerCallbackQuery(`Notified ${count} candidates! 🚀`);
            await ctx.menu.update();
        }).row();

        const waitlisted = await mentorService.getCandidates(true);
        for (const cand of waitlisted) {
            const label = `⌛ ${formatCompactName(cand.fullName || "Cand")} • [${getCityCode(cand.city)}] ${getShortLocationName(cand.location?.name, cand.city)}`;
            range.text(label, async (ctx) => {
                ctx.session.selectedCandidateId = cand.id;
                const text = await getMentorCandidateProfileText(ctx, cand.id);
                await ScreenManager.renderScreen(ctx, text, "mentor-inbox-details", { pushToStack: true });
            }).row();
        }
        
        range.text("⬅️ Back to Inbox", async (ctx) => {
            ctx.session.filterWaitlist = false;
            await ctx.menu.update();
        });
        return;
    }

    const candidates = await mentorService.getActionNeededCandidates();
    const hasAnyTasks = stats.unreadMessagesCount > 0 || stats.waitlistCount > 0 || candidates.length > 0;

    if (!hasAnyTasks) {
        range.text("All tasks completed! ✨", (ctx) => ctx.answerCallbackQuery("Nothing to do!")).row();
    } else {
        if (stats.unreadMessagesCount > 0) {
            range.text(`💬 Messages ${stats.unreadMessagesCount}`, async (ctx) => {
                await ScreenManager.renderScreen(ctx, "💬 <b>Messages</b>\nConversations waiting for your reply: 👇", "mentor-messages", { pushToStack: true });
            }).row();
        }

        if (stats.waitlistCount > 0) {
            range.text(`⌛ Waitlist ${stats.waitlistCount}`, async (ctx) => {
                ctx.session.filterWaitlist = true;
                await ctx.menu.update();
            }).row();
        }

        if ((stats.unreadMessagesCount > 0 || stats.waitlistCount > 0) && candidates.length > 0) {
            range.text("--------------------").row();
        }

        for (const cand of candidates) {
            let icon = "🆕";
            let timeLabel = "";

            if (cand.status === "DISCOVERY_COMPLETED") {
                icon = "✅";
            } else if (cand.materialsSent) {
                icon = "📚";
                if (cand.materialsSentAt) {
                    const diff = new Date().getTime() - new Date(cand.materialsSentAt).getTime();
                    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
                    timeLabel = days > 0 ? ` (${days}d)` : " (today)";
                }
            }

            const label = `${icon} ${formatCompactName(cand.fullName || "Cand")} • [${getCityCode(cand.city)}] ${getShortLocationName(cand.location?.name, cand.city)}${timeLabel}`;
            range.text(label, async (ctx) => {
                ctx.session.selectedCandidateId = cand.id;
                const text = await getMentorCandidateProfileText(ctx, cand.id);
                await ScreenManager.renderScreen(ctx, text, "mentor-inbox-details", { pushToStack: true });
            }).row();
        }

        if (stats.newAcceptedCount > 0) {
            range.text("📢 Broadcast Materials", async (ctx) => {
                await ScreenManager.renderScreen(ctx, "Select city for broadcast: 🏙️", "mentor-broadcast-cities", { pushToStack: true });
            }).row();
        }
    }

    range.text("🏠 Back to Hub", async (ctx) => {
        await ScreenManager.goBack(ctx, await mentorService.getHubText(), "mentor-hub-menu");
    });
});

// --- MESSAGES LIST ---
mentorMessagesMenu.dynamic(async (ctx, range) => {
    const candidates = await mentorService.getCandidatesWithUnreadMessages("MENTOR");
    
    if (candidates.length === 0) {
        range.text("No new messages. ✨", (ctx) => ctx.answerCallbackQuery("All read!")).row();
    } else {
        for (const cand of candidates) {
            const lastMsg = (cand as any).messages?.[0]?.content || "Media message";
            const snippet = lastMsg.length > 20 ? lastMsg.substring(0, 17) + "..." : lastMsg;
            
            range.text(`💬 ${cand.fullName}: "${snippet}"`, async (ctx) => {
                ctx.session.selectedCandidateId = cand.id;
                const text = await getMentorCandidateProfileText(ctx, cand.id);
                await ScreenManager.renderScreen(ctx, text, "mentor-inbox-details", { pushToStack: true });
                await candidateRepository.update(cand.id, { hasUnreadMessage: false });
            }).row();
        }
    }

    range.text("⬅️ Back", (ctx) => ScreenManager.goBack(ctx, "📥 <b>Inbox</b>", "mentor-inbox"));
});

// --- 3. DETAILS ---
mentorInboxDetailsMenu.dynamic(async (ctx, range) => {
    const candId = ctx.session.selectedCandidateId;
    if (!candId) return;

    const details = await mentorService.getCandidateDetails(candId);
    if (!details || !details.cand) return;
    const { cand } = details;

    if (cand.status === "DISCOVERY_COMPLETED") {
        range.text("🗓 Assign Online Internship", async (ctx) => {
            await ScreenManager.renderScreen(ctx, `🗓 <b>Assign Online Internship</b>\n\nPlease select the date for ${cand.fullName}:`, "mentor-manual-date", { pushToStack: true });
        }).row();
    }
    else if (cand.status === "DISCOVERY_SCHEDULED") {
        range.text("✅ Discovery Passed", async (ctx) => {
            await ctx.answerCallbackQuery();
            const res = await mentorService.completeDiscovery(ctx.api, cand.id, 'passed');
            if (res) {
                await ScreenManager.renderScreen(ctx, `✨ <b>Discovery Passed!</b>\n\nNow please select the <b>Online Internship Date</b> for ${res.candidate.fullName}:`, "mentor-manual-date", { pushToStack: true });
            }
        })
        .text("❌ Failed", async (ctx) => {
            await ctx.answerCallbackQuery();
            await mentorService.completeDiscovery(ctx.api, cand.id, 'failed');
            await ctx.menu.update();
        }).row();
    }
    else if (cand.status === "TRAINING_SCHEDULED") {
        range.text("✅ Training Completed", async (ctx) => {
            await ctx.answerCallbackQuery();
            await mentorService.completeTraining(ctx.api, cand.id, 'passed');
            await ctx.menu.update();
        })
        .text("❌ Failed", async (ctx) => {
            await ctx.answerCallbackQuery();
            await mentorService.completeTraining(ctx.api, cand.id, 'failed');
            await ctx.menu.update();
        }).row();
    }
    else if (cand.status === "ACCEPTED" || cand.status === "WAITLIST") {
        if (!cand.materialsSent) {
            const label = cand.status === "WAITLIST" ? "📚 Invite to Discovery" : "📚 Send Materials";
            range.text(label, async (ctx) => {
                const result = await mentorService.sendMaterials(ctx.api, cand.id);
                if (result) {
                    await ctx.api.sendMessage(result.telegramId, result.text, {
                        parse_mode: "HTML",
                        reply_markup: new InlineKeyboard().text("🗓️ Обрати час знайомства", "start_training_scheduling")
                    });
                    await ctx.answerCallbackQuery("Sent! ✅");
                }
                await ctx.menu.update();
            }).row();
        } else if (!cand.discoverySlotId) {
            range.text("🔔 Send Reminder", async (ctx) => {
                const result = await mentorService.sendMaterials(ctx.api, cand.id);
                if (result) {
                    await ctx.api.sendMessage(result.telegramId, result.text, {
                        parse_mode: "HTML",
                        reply_markup: new InlineKeyboard().text("🗓️ Обрати час знайомства", "start_training_scheduling")
                    });
                    await ctx.answerCallbackQuery("Reminder sent! 🔔");
                }
                await ctx.menu.update();
            }).row();
        }
    }
    if (cand.status !== "TRAINING_COMPLETED") {
        range.text("✍️ Reply", async (ctx) => {
            const userId = cand.user?.telegramId;
            if (userId) {
                await ctx.reply(`Enter message for ${cand.fullName}: ✍️`);
                ctx.session.step = `admin_reply_${userId}`;
                await ctx.answerCallbackQuery("✓");
                await candidateRepository.update(cand.id, { hasUnreadMessage: false });
            }
        }).row();
    }

    range.text("⬅️ Back", (ctx) => ScreenManager.goBack(ctx, "📥 <b>Inbox</b>", "mentor-inbox"));
});

// --- 4. MANUAL TRAINING ASSIGNMENT ---
mentorManualTrainingDateMenu.dynamic(async (ctx, range) => {
    const candId = ctx.session.selectedCandidateId;
    const cand = candId ? await candidateRepository.findById(candId) : null;
    const isInternship = cand?.status === "DISCOVERY_COMPLETED" || cand?.status === "DISCOVERY_SCHEDULED";

    if (isInternship) {
        range.text("🗓️ Pick date for Internship:", (ctx) => {}).row();
        const now = new Date();
        for (let i = 0; i < 7; i++) {
            const d = new Date();
            d.setDate(now.getDate() + i);
            const day = d.getDate().toString().padStart(2, '0');
            const month = (d.getMonth() + 1).toString().padStart(2, '0');
            const dateStr = `${day}.${month}`;
            const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });

            range.text(`${dayName}, ${dateStr}`, async (ctx) => {
                ctx.session.selectedTrainingDate = dateStr;
                await ScreenManager.renderScreen(ctx, `⏰ <b>Times for ${dateStr}:</b>`, "mentor-manual-time-selection", { pushToStack: true });
            });
            if ((i + 1) % 2 === 0) range.row();
        }
    } else {
        range.text("📅 Select Discovery date:", (ctx) => {}).row();
        const dates = await mentorService.getTrainingSlots();
        if (dates.length === 0) {
            range.text("No available slots in calendar", (ctx) => ctx.answerCallbackQuery("Create slots first!")).row();
        }
        for (const date of dates) {
            range.text(date as string, async (ctx) => {
                ctx.session.selectedTrainingDate = date as string;
                await ScreenManager.renderScreen(ctx, `🕒 <b>Select Time for ${date}:</b>`, "mentor-manual-time", { pushToStack: true });
            }).row();
        }
    }
    range.row().text("⬅️ Cancel", (ctx) => ScreenManager.goBack(ctx, "👤 Profile", "mentor-inbox-details"));
});

mentorManualTimeSelectionMenu.dynamic(async (ctx, range) => {
    const date = ctx.session.selectedTrainingDate;
    const candId = ctx.session.selectedCandidateId;
    if (!date || !candId) return;

    const cand = await candidateRepository.findById(candId);
    if (!cand) return;

    const times = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"];
    times.forEach((t, i) => {
        range.text(t, async (ctx) => {
            const result = await mentorService.bookTrainingSlotFromText(candId, `${date} ${t}`);
            if (result.success) {
                if (result.notification) {
                    await ctx.api.sendMessage(result.notification.telegramId, result.notification.text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch(() => {});
                }
                await ctx.answerCallbackQuery(`Scheduled for ${t}! ✅`);
                await ScreenManager.renderScreen(ctx, `✅ <b>Scheduled for ${date} ${t}!</b>\n\nCandidate has been notified.`, "mentor-action-success");
            } else {
                await ctx.answerCallbackQuery(result.error || "Error ❌");
            }
        });
        if ((i + 1) % 4 === 0) range.row();
    });

    range.row().text("✍️ Custom...", async (ctx) => {
        await ctx.reply(`✍️ <b>Enter Custom Start Time for ${date}:</b>\n\nCandidate: <b>${cand.fullName}</b>\nFormat: <code>HH:MM</code>\nExample: <code>14:15</code>`, { parse_mode: "HTML" });
        ctx.session.step = `wait_mentor_custom_time_${candId}_${date}`;
        await ctx.answerCallbackQuery();
    }).row();

    range.text("⬅️ Back", (ctx) => ScreenManager.goBack(ctx, "🗓 Dates", "mentor-manual-date"));
});

mentorManualTrainingTimeMenu.dynamic(async (ctx, range) => {
    const date = ctx.session.selectedTrainingDate;
    const candId = ctx.session.selectedCandidateId;
    if (!date || !candId) return;

    const cand = await candidateRepository.findById(candId);
    if (!cand) return;

    const isDiscovery = cand.status === "ACCEPTED" || cand.status === "WAITLIST";
    const slots = await mentorService.getTrainingSlots(date);
    const freeSlots = slots.filter((s: any) => !s.isBooked);

    if (freeSlots.length === 0) {
        range.text("No free slots", (ctx) => {}).row();
    } else {
        for (const slot of freeSlots) {
            const timeStr = slot.startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
            range.text(timeStr, async (ctx) => {
                const { bookingService } = await import("../services/booking-service.js");
                const tid = Number(cand.user.telegramId);
                if (isDiscovery) {
                    await bookingService.bookDiscoverySlot(tid, slot.id);
                    await ctx.api.sendMessage(tid, CANDIDATE_TEXTS["mentor-manual-discovery-assigned"](date, timeStr), { parse_mode: "HTML" });
                } else {
                    await bookingService.bookTrainingSlot(tid, slot.id);
                }
                await ctx.answerCallbackQuery(`Scheduled! ✅`);
                await ScreenManager.renderScreen(ctx, `✅ <b>Scheduled for ${date} ${timeStr}!</b>\n\nCandidate has been notified.`, "mentor-action-success");
            });
        }
    }

    range.row().text("✍️ Manual Time...", async (ctx) => {
        await ctx.reply(`✍️ <b>Enter Custom Start Time for ${date}:</b>\n\nCandidate: <b>${cand.fullName}</b>\nFormat: <code>HH:MM</code>\nExample: <code>14:15</code>`, { parse_mode: "HTML" });
        ctx.session.step = `wait_mentor_manual_time_${candId}_${date}_${isDiscovery ? 'discovery' : 'training'}`;
        await ctx.answerCallbackQuery();
    }).row();

    range.text("⬅️ Back", (ctx) => ScreenManager.goBack(ctx, "🗓 Dates", "mentor-manual-date"));
});

// --- 5. CALENDAR ---
mentorTrainingDatesMenu.dynamic(async (ctx, range) => {
    const dates = await mentorService.getTrainingSlots();
    for (const date of dates) {
        range.text(date as string, async (ctx) => {
            ctx.session.selectedTrainingDate = date as string;
            const slots = await mentorService.getTrainingSlots(date as string);
            await ScreenManager.renderScreen(ctx, `🗓️ <b>Schedule for ${date}:</b>\n\nMeetings: ${slots.filter((s: any) => s.isBooked).length}`, "mentor-training-day-view", { pushToStack: true });
        }).row();
    }

    range.row().text("➕ Add New Slots", async (ctx) => {
        const { createDatePickerKb } = await import("../utils/slot-builder.js");
        await ctx.reply("📅 <b>Select Date for Discovery Slots:</b>", { parse_mode: "HTML", reply_markup: createDatePickerKb("mentor_sb") });
        await ctx.answerCallbackQuery("✓");
    }).row();

    range.text("🏠 Back", async (ctx) => {
        await ScreenManager.goBack(ctx, await mentorService.getHubText(), "mentor-hub-menu");
    });
});

mentorTrainingDayViewMenu.dynamic(async (ctx, range) => {
    const dateStr = ctx.session.selectedTrainingDate;
    if (!dateStr) return;
    const slots = await mentorService.getTrainingSlots(dateStr);

    for (const slot of slots) {
        const time = (slot as any).startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
        if (slot.isBooked) {
            const cand = (slot as any).candidate || (slot as any).candidateDiscovery;
            const isDiscovery = !!(slot as any).candidateDiscovery;
            range.text(`${isDiscovery ? '🔍' : '🎓'} ${time} - ${formatCompactName(cand?.fullName || 'Candidate')}`, async (ctx) => {
                if (!cand) return;
                ctx.session.selectedCandidateId = cand.id;
                const text = await getMentorCandidateProfileText(ctx, cand.id);
                await ScreenManager.renderScreen(ctx, text, "mentor-inbox-details", { pushToStack: true });
            }).row();
        } else {
            range.text(`🔘 ${time}`, (ctx) => ctx.answerCallbackQuery("Available")).text("🗑️", async (ctx) => {
                const res = await mentorService.deleteTrainingSlot(slot.id);
                if (res) { await ctx.answerCallbackQuery("Deleted ✅"); await ctx.menu.update(); }
                else { await ctx.answerCallbackQuery("Error ❌"); }
            }).row();
        }
    }
    range.row().text("⬅️ Back", (ctx) => ScreenManager.goBack(ctx, "🗓 Dates", "mentor-training-dates"));
});

// --- 6. ONBOARDING ---
mentorOnboardingMenu.dynamic(async (ctx, range) => {
    const candidates = await mentorService.getOnboardingCandidates();
    const dateGroups: Record<string, number> = {};
    candidates.forEach((cand: any) => {
        const d = cand.firstShiftDate ? new Date(cand.firstShiftDate).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv' }) : "No Date";
        dateGroups[d] = (dateGroups[d] || 0) + 1;
    });
    for (const d of Object.keys(dateGroups)) {
        range.text(`🗓 ${d} (${dateGroups[d]})`, async (ctx) => {
            ctx.session.selectedOnboardingDate = d;
            await ScreenManager.renderScreen(ctx, `🚀 <b>Onboarding for ${d}:</b>`, "mentor-onboarding-day", { pushToStack: true });
        }).row();
    }
    range.text("🏠 Back", async (ctx) => {
        await ScreenManager.goBack(ctx, await mentorService.getHubText(), "mentor-hub-menu");
    });
});

mentorOnboardingDayMenu.dynamic(async (ctx, range) => {
    const selectedDate = ctx.session.selectedOnboardingDate;
    const candidates = await mentorService.getOnboardingCandidates();
    const filtered = candidates.filter((c: any) => (c.firstShiftDate ? new Date(c.firstShiftDate).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv' }) : "No Date") === selectedDate);
    for (const c of filtered) {
        range.text(`👤 ${formatCompactName(c.fullName)}`, async (ctx) => {
            ctx.session.selectedCandidateId = c.id;
            const text = await getMentorCandidateProfileText(ctx, c.id);
            await ScreenManager.renderScreen(ctx, text, "mentor-onboarding-details", { pushToStack: true });
        }).row();
    }
    range.text("⬅️ Back", (ctx) => ScreenManager.goBack(ctx, "🚀 Onboarding", "mentor-onboarding"));
});

mentorOnboardingDetailsMenu.dynamic(async (ctx, range) => {
    const candId = ctx.session.selectedCandidateId;
    if (!candId) return;

    const details = await mentorService.getCandidateDetails(candId);
    const cand = details?.cand;

    if (cand) {
        const username = cand.user?.username;
        const tid = Number(cand.user?.telegramId);
        if (username) {
            range.url("💬 Contact Candidate", `https://t.me/${username}`).row();
        } else if (tid) {
            range.url("💬 Contact Candidate", `tg://user?id=${tid}`).row();
        }
    }

    range.text("✅ Successful Onboarding", async (ctx) => {
        await mentorService.completeOnboarding(candId, true);
        await ScreenManager.renderScreen(ctx, "🚀 <b>Onboarding Successful!</b>", "mentor-onboarding");
    }).row();
    range.text("❌ Failed", async (ctx) => {
        await mentorService.completeOnboarding(candId, false);
        await ScreenManager.renderScreen(ctx, "Onboarding failed.", "mentor-onboarding");
    }).row();
    range.text("⬅️ Back", (ctx) => ScreenManager.goBack(ctx, "🚀 Onboarding Day", "mentor-onboarding-day"));
});

// --- BROADCAST ---
mentorBroadcastCitiesMenu.dynamic(async (ctx, range) => {
    const cities = await mentorService.getBroadcastCities();
    for (const city of cities) {
        range.text(`${city.name} (${city.count})`, async (ctx) => {
            ctx.session.broadcastCity = city.name;
            await ScreenManager.renderScreen(ctx, `Are you sure you want to send materials to ALL in <b>${city.name}</b>?`, "mentor-broadcast-combined-confirm", { pushToStack: true });
        }).row();
    }
    range.text("⬅️ Back", (ctx) => ScreenManager.goBack(ctx, "📥 Inbox", "mentor-inbox"));
});

mentorBroadcastCombinedConfirmMenu.text("✅ YES, send", async (ctx) => {
    const city = ctx.session.broadcastCity;
    if (!city) return;
    const candidates = await mentorService.getBroadcastCandidates(city);
    for (const cand of candidates) {
        const result = await mentorService.sendMaterials(ctx.api, cand.id);
        if (result) {
            await ctx.api.sendMessage(result.telegramId, result.text, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🗓️ Обрати час знайомства", "start_training_scheduling") });
        }
    }
    await ctx.answerCallbackQuery(`📢 Sent to ${candidates.length} candidates!`);
    await ScreenManager.renderScreen(ctx, `✅ <b>Broadcast Successful!</b>\n\nMaterials sent to ${candidates.length} candidates in ${city}.`, "mentor-action-success");
}).row().text("⬅️ Cancel", (ctx) => ScreenManager.goBack(ctx, "🏙 Cities", "mentor-broadcast-cities"));

// --- REGISTRATION ---
export const mentorHandlers = new Composer<MyContext>();
mentorRootMenu.register(mentorHubMenu);
mentorHubMenu.register(mentorInboxMenu);
mentorInboxMenu.register(mentorMessagesMenu);
mentorInboxMenu.register(mentorInboxDetailsMenu);
mentorInboxDetailsMenu.register(mentorManualTrainingDateMenu);
mentorManualTrainingDateMenu.register(mentorManualTrainingTimeMenu);
mentorManualTrainingDateMenu.register(mentorManualTimeSelectionMenu);
mentorHubMenu.register(mentorTrainingDatesMenu);
mentorTrainingDatesMenu.register(mentorTrainingDayViewMenu);
mentorHubMenu.register(mentorOnboardingMenu);
mentorOnboardingMenu.register(mentorOnboardingDayMenu);
mentorOnboardingDayMenu.register(mentorOnboardingDetailsMenu);
mentorInboxMenu.register(mentorBroadcastCitiesMenu);
mentorBroadcastCitiesMenu.register(mentorBroadcastCombinedConfirmMenu);
mentorHubMenu.register(mentorActionSuccessMenu);

mentorHandlers.callbackQuery("mentor_train_calendar", async (ctx) => {
    await ctx.answerCallbackQuery();
    await updateCalendarDashboard(ctx);
});

mentorHandlers.callbackQuery("mentor_back_calendar_root", async (ctx) => {
    await ctx.answerCallbackQuery();
    await updateCalendarDashboard(ctx);
});
