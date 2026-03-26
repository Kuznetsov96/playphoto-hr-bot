import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { createDatePickerKb, createTimePickerKb, createDurationPickerKb } from "../utils/slot-builder.js";
import { interviewService } from "../services/interview-service.js";
import { mentorService } from "../services/mentor-service.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { createKyivDate } from "../utils/bot-utils.js";

export const slotBuilderHandlers = new Composer<MyContext>();

// 1. DATE SELECTION
slotBuilderHandlers.callbackQuery(/^(hr|mentor)_sb_date_(.+)$/, async (ctx) => {
    const role = ctx.match[1];
    const value = ctx.match[2];
    let dateStr = value;

    if (value === 'today') {
        dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
    } else if (value === 'tomorrow') {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(tomorrow);
    }

    ctx.session.slotBuilder = { 
        date: dateStr!
    };
    const kb = createTimePickerKb(`${role}_sb`);
    await ctx.editMessageText(`🗓 <b>Date: ${dateStr}</b>\n\nNow, select the <b>Start Time</b>:`, {
        parse_mode: "HTML",
        reply_markup: kb
    });
    await ctx.answerCallbackQuery();
});

// 2. TIME SELECTION
slotBuilderHandlers.callbackQuery(/^(hr|mentor)_sb_time_(\d+)$/, async (ctx) => {
    const role = ctx.match[1];
    const hour = parseInt(ctx.match[2]!);

    if (!ctx.session.slotBuilder) {
        ctx.session.slotBuilder = { date: new Date().toISOString().split('T')[0] || "", startHour: hour, startMinute: 0 };
    } else {
        ctx.session.slotBuilder.startHour = hour;
        ctx.session.slotBuilder.startMinute = 0;
    }

    const kb = createDurationPickerKb(`${role}_sb`);
    if (ctx.session.slotBuilder) {
        await ctx.editMessageText(`🗓 <b>Date: ${ctx.session.slotBuilder.date}</b>\n🕒 <b>Start: ${hour}:00</b>\n\nSelect <b>Duration</b> or <b>Window size</b>:`, {
            parse_mode: "HTML",
            reply_markup: kb
        });
    }
    await ctx.answerCallbackQuery();
});

// 3. DURATION SELECTION (PRESETS OR CUSTOM)
slotBuilderHandlers.callbackQuery(/^(hr|mentor)_sb_dur_custom$/, async (ctx) => {
    const role = ctx.match[1];
    ctx.session.step = `${role}_sb_wait_custom_end`;
    
    if (role === 'mentor') {
        await ctx.editMessageText("✍️ <b>Enter Start Time:</b>\n\nExample:\n• <code>17:50</code>\n\n<i>Bot will create a slot + break automatically. ✨</i>", {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("⬅️ Back", `${role}_sb_back_dur`)
        });
    } else {
        await ctx.editMessageText("✍️ <b>Enter Start Time & End Time (or Hours):</b>\n\nExamples:\n• <code>16:30-18:30</code> (specific interval)\n• <code>18:30</code> (end time, start stays same)\n• <code>5</code> (duration in hours)", {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("⬅️ Back", `${role}_sb_back_dur`)
        });
    }
    await ctx.answerCallbackQuery();
});

slotBuilderHandlers.callbackQuery(/^(hr|mentor)_sb_dur_(\d+)$/, async (ctx) => {
    const role = ctx.match[1];
    const duration = parseInt(ctx.match[2]!);
    await executeSlotCreation(ctx, role as any, duration);
    await ctx.answerCallbackQuery();
});

// 4. CUSTOM DURATION TEXT PARSER
slotBuilderHandlers.on("message:text", async (ctx, next) => {
    const step = ctx.session.step || "";
    if (!step.endsWith("_sb_wait_custom_end")) return next();

    const role = step.startsWith("hr") ? "hr" : "mentor";
    const text = ctx.message.text.trim();
    const sb = ctx.session.slotBuilder;

    if (!sb || !sb.date || sb.startHour === undefined) {
        ctx.session.step = "idle";
        return ctx.reply("❌ Session lost. Start over.");
    }

    let durationMins = 0;

    // Parse logic: HH:MM-HH:MM (Range)
    const rangeMatch = text.match(/^(\d{1,2})[:.](\d{2})\s*-\s*(\d{1,2})[:.](\d{2})/);
    // Parse logic: HH:MM (Time)
    const timeMatch = text.match(/^(\d{1,2})[:.](\d{2})/);
    // Parse logic: 5 (Duration in hours)
    const hourMatch = text.match(/^(\d{1,2})$/);

    if (rangeMatch) {
        const startH = parseInt(rangeMatch[1]!);
        const startM = parseInt(rangeMatch[2]!);
        const endH = parseInt(rangeMatch[3]!);
        const endM = parseInt(rangeMatch[4]!);
        sb.startHour = startH;
        sb.startMinute = startM;
        const [y, m, d] = sb.date.split('-').map(Number);
        const start = createKyivDate(y!, m! - 1, d!, startH, startM);
        const end = createKyivDate(y!, m! - 1, d!, endH, endM);
        durationMins = (end.getTime() - start.getTime()) / 60000;
    } else if (timeMatch) {
        const hour = parseInt(timeMatch[1]!);
        const min = parseInt(timeMatch[2]!);
        
        if (role === 'mentor') {
            // New simplified logic for Mentors: HH:MM is the START time.
            sb.startHour = hour;
            sb.startMinute = min;
            durationMins = 30; // 20 min slot + 10 min break = 30 min block
        } else {
            // Standard logic for HR: HH:MM is the END time.
            const [y, m, d] = sb.date.split('-').map(Number);
            const start = createKyivDate(y!, m! - 1, d!, sb.startHour, sb.startMinute || 0);
            const end = createKyivDate(y!, m! - 1, d!, hour, min);
            durationMins = (end.getTime() - start.getTime()) / 60000;
        }
    } else if (hourMatch) {
        durationMins = parseInt(hourMatch[1]!) * 60;
    }

    if (durationMins <= 0 || durationMins > 720) {
        return ctx.reply("⚠️ Invalid time. End time must be later than start and window < 12h.");
    }

    await executeSlotCreation(ctx, role as any, durationMins);
});

async function executeSlotCreation(ctx: MyContext, role: 'hr' | 'mentor', duration: number) {
    const sb = ctx.session.slotBuilder;
    if (!sb || !sb.date || sb.startHour === undefined) {
        return ctx.reply("Error: Session data missing.");
    }

    const [y, m, d] = sb.date.split('-').map(Number);
    const start = createKyivDate(y!, m! - 1, d!, sb.startHour, sb.startMinute || 0);
    const end = new Date(start.getTime() + duration * 60000);
    const candId = ctx.session.selectedCandidateId;

    try {
        if (role === 'hr') {
            const timeLabel = `${sb.startHour}:${(sb.startMinute || 0).toString().padStart(2, '0')}`;
            if (candId) {
                const dbSlot = await interviewService.createSingleSlot(start, 15, candId);
                const { candidateRepository } = await import("../repositories/candidate-repository.js");
                const { CandidateStatus } = await import("@prisma/client");
                await candidateRepository.update(candId, {
                    status: CandidateStatus.INTERVIEW_SCHEDULED,
                    interviewSlot: { connect: { id: dbSlot.id } }
                });
                const kb = new InlineKeyboard().text(STAFF_TEXTS["hr-btn-back-to-calendar"], "hr_main_calendar");
                const resp = `✅ <b>Interview Scheduled!</b>\n\nDate: ${start.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}`;
                if (ctx.callbackQuery) await ctx.editMessageText(resp, { parse_mode: "HTML", reply_markup: kb });
                else await ctx.reply(resp, { parse_mode: "HTML", reply_markup: kb });
            } else {
                if (duration === 15) await interviewService.createSingleSlot(start);
                else await interviewService.createSessionWithSlots(start, end);
                const kb = new InlineKeyboard().text(STAFF_TEXTS["hr-btn-back-to-calendar"], "hr_main_calendar");
                const resp = `✅ <b>Success!</b>\n\nSlots created for ${start.toLocaleDateString('uk-UA')} starting at ${timeLabel}.`;
                if (ctx.callbackQuery) await ctx.editMessageText(resp, { parse_mode: "HTML", reply_markup: kb });
                else await ctx.reply(resp, { parse_mode: "HTML", reply_markup: kb });
            }
        } else {
            const [y, m, d] = sb.date.split('-').map(Number);
            const dateFmt = `${d! < 10 ? '0' + d! : d!}.${m! < 10 ? '0' + m! : m!}.${y}`;
            
            // Apple Style: Explicitly format in Kyiv time to avoid server timezone issues
            const formatTime = (date: Date) => {
                return new Intl.DateTimeFormat('uk-UA', {
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZone: 'Europe/Kyiv'
                }).format(date).replace(':', ':');
            };

            const startTimeStr = `${sb.startHour}:${(sb.startMinute || 0).toString().padStart(2, '0')}`;
            const endTimeStr = formatTime(end);
            
            const result = await mentorService.createTrainingSlotFromText(`${dateFmt} ${startTimeStr}-${endTimeStr}`, candId);
            
            if (result.success) {
                const count = (result as any).createdCount || 0;
                const resp = `✅ <b>Training Slots Created!</b>\n\nCreated ${count} slots for discovery meetings. ✨`;
                const kb = new InlineKeyboard().text("⬅️ Back to Training", "mentor_train_calendar");
                if (ctx.callbackQuery) await ctx.editMessageText(resp, { parse_mode: "HTML", reply_markup: kb });
                else await ctx.reply(resp, { parse_mode: "HTML", reply_markup: kb });
            } else {
                const errorMsg = (result as any).error || "Unknown error";
                if (ctx.callbackQuery) await ctx.editMessageText(errorMsg, { reply_markup: new InlineKeyboard().text("⬅️ Back", "mentor_sb_back_dur") });
                else await ctx.reply(errorMsg);
            }
        }
        delete ctx.session.slotBuilder;
        ctx.session.step = "idle";
    } catch (e: any) {
        await ctx.reply(`❌ Error: ${e.message}`);
    }
}

// BACK NAVIGATION
slotBuilderHandlers.callbackQuery(/^(hr|mentor)_sb_back_dates$/, async (ctx) => {
    const role = ctx.match[1];
    await ctx.editMessageText("📅 <b>Select Date:</b>", {
        parse_mode: "HTML",
        reply_markup: createDatePickerKb(`${role}_sb`)
    });
});

slotBuilderHandlers.callbackQuery(/^(hr|mentor)_sb_back_time$/, async (ctx) => {
    const role = ctx.match[1];
    await ctx.editMessageText("🕒 <b>Select Start Time:</b>", {
        parse_mode: "HTML",
        reply_markup: createTimePickerKb(`${role}_sb`)
    });
});

slotBuilderHandlers.callbackQuery(/^(hr|mentor)_sb_back_dur$/, async (ctx) => {
    const role = ctx.match[1];
    ctx.session.step = "idle";
    await ctx.editMessageText("🕒 Select <b>Duration</b> or <b>Window size</b>:", {
        parse_mode: "HTML",
        reply_markup: createDurationPickerKb(`${role}_sb`)
    });
});
