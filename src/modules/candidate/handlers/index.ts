import type { MyContext } from "../../../types/context.js";
import { formatLocation } from "../../../utils/location-label.js";
import { escapeHtml } from "../../../handlers/admin/utils.js";
import { CANDIDATE_TEXTS } from "../../../constants/candidate-texts.js";
import { InlineKeyboard, Composer } from "grammy";
import { z } from "zod";
import { CandidateStatus, FunnelStep } from "@prisma/client";
import logger from "../../../core/logger.js";
import { extractFirstName } from "../../../utils/string-utils.js";
import { getCityCode, getShortLocationName } from "../../../utils/location-helpers.js";
import { ScreenManager } from "../../../utils/screen-manager.js";
import { readCallbackPayload } from "../../../utils/signed-callback.js";
import {
    MIN_VOLKLAND_2_ZP_CANDIDATE_AGE,
    getAgeRejection,
    getCandidateAge,
    type CandidateAgeLocation,
} from "../../../utils/candidate-age.js";

// --- HELPERS ---
/**
 * Safely extract locationIds array from candidateData.
 * Guards against undefined, falls back to [] if needed.
 * Always returns an array to prevent undefined bugs.
 */
function getLocationIds(candidateData: any): string[] {
    if (!candidateData) return [];
    if (Array.isArray(candidateData.locationIds) && candidateData.locationIds.length > 0) {
        return candidateData.locationIds;
    }
    // Fallback: Try to use single locationId if it exists
    if (candidateData.locationId) return [candidateData.locationId];
    return [];
}

function getAgeRejectionMeta(age: number, location?: CandidateAgeLocation) {
    const rejection = getAgeRejection(age, location);
    if (rejection === "UNDERAGE") {
        return {
            status: CandidateStatus.REJECTED,
            isWaitlisted: false,
            hrDecision: "REJECTED_SYSTEM_UNDERAGE" as string | null,
            finalKey: "candidate-reject-underage" as const,
            reasonCode: "UNDERAGE" as const
        };
    }
    if (rejection === "AGE_LIMIT") {
        return {
            status: CandidateStatus.REJECTED,
            isWaitlisted: false,
            hrDecision: "AGE_LIMIT" as string | null,
            finalKey: "candidate-reject-age-limit" as const,
            reasonCode: "AGE_LIMIT" as const
        };
    }
    return {
        status: CandidateStatus.WAITLIST_HR,
        isWaitlisted: true,
        hrDecision: null,
        finalKey: "candidate-success-waitlist" as const,
        reasonCode: "NO_VACANCIES" as const
    };
}

// --- VALIDATION SCHEMAS ---
export const CandidateSchema = z.object({
    fullName: z.string()
        .min(5, "ПІБ має бути не менше 5 символів")
        .max(100, "ПІБ занадто довге")
        .refine(val => val.trim().split(/\s+/).length >= 2, "Введіть Ім'я та Прізвище (через пробіл)")
        .refine(val => !val.startsWith("/"), "Це схоже на команду, введіть ім'я")
        .refine(val => !/\d/.test(val), "Ім'я не може містити цифри"),
    birthDate: z.date()
        .refine(date => date > new Date(1950, 0, 1) && date <= new Date(), "Введіть реальну дату народження"),
});

export function shouldDeferCandidateAtBirthDate(birthDate: Date | string): boolean {
    return getCandidateAge(birthDate) < MIN_VOLKLAND_2_ZP_CANDIDATE_AGE;
}

// --- CORE LOGIC ---

export async function persistCandidate(ctx: MyContext, data: any) {
    const { userRepository, candidateRepository } = ctx.di;
    const telegramId = BigInt(ctx.from?.id || 0);

    const user = await userRepository.upsert({
        where: { telegramId },
        create: { telegramId, username: ctx.from?.username || null, firstName: ctx.from?.first_name || null },
        update: { username: ctx.from?.username || null, firstName: ctx.from?.first_name || null }
    });

    if (data.currentStep && !Object.values(FunnelStep).includes(data.currentStep)) {
        data.currentStep = FunnelStep.INITIAL_TEST;
    }

    const createData = data.gender === undefined
        ? { userId: user.id, gender: null, ...data }
        : { userId: user.id, ...data };

    return await candidateRepository.upsert({
        where: { userId: user.id },
        create: createData,
        update: { ...data }
    });
}

export async function startScreening(ctx: MyContext) {
    const candidateData = ctx.session.candidateData;
    logger.info({
        event: "candidate.screening.started",
        correlation_id: ctx.correlationId,
        update_id: ctx.update.update_id,
        telegram_id: ctx.from?.id != null ? String(ctx.from.id) : undefined,
        stage: "SCREENING",
        result: "started"
    }, "Candidate screening started/resumed");

    if (!candidateData.fullName) {
        ctx.session.step = "screening_name";
        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["welcome-message"] + "\n\n" + CANDIDATE_TEXTS["ask-name"]);
    } else if (!candidateData.gender) {
        ctx.session.step = "screening_gender";
        const firstName = extractFirstName(candidateData.fullName || "");
        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-greeting-nicetomeet"](firstName), "candidate-gender");
    } else if (!candidateData.birthDate) {
        ctx.session.step = "screening_birthdate";
        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-ask-birthday"]);
    } else if (!candidateData.city) {
        ctx.session.step = "screening_city";
        await triggerPrompt(ctx, "screening_city");
    } else if (getLocationIds(candidateData).length === 0) {
        ctx.session.step = "screening_location";
        await triggerPrompt(ctx, "screening_location");
    } else if (!candidateData.appearance) {
        ctx.session.step = "screening_appearance_prompt";
        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-ask-appearance"], "candidate-appearance");
    } else {
        ctx.session.step = "screening_source";
        await triggerPrompt(ctx, "screening_source");
    }
}

export async function renderLocationSelectionContent(ctx: MyContext) {
    const city = ctx.session.candidateData.city!;
    const { locationRepository } = ctx.di;
    const locations = await locationRepository.findByCity(city, true);

    let text = CANDIDATE_TEXTS["candidate-ask-location-multiple"] + "\n\n";
    locations.forEach((l: any, i: number) => {
        const street = (l.address?.split(',')[1]?.trim() || l.address || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const nameEscaped = escapeHtml(formatLocation(l, "in-city"));
        const maps = l.googleMapsLink ? ` (<a href="${l.googleMapsLink}">на мапі</a>)` : "";
        text += `${i + 1}. <b>${nameEscaped}</b>\n📍 <i>${street}</i>${maps}\n\n`;
    });

    return { text, kb: "candidate-location" };
}

async function renderLocationSelection(ctx: MyContext) {
    try {
        const { text, kb } = await renderLocationSelectionContent(ctx);
        await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true });
    } catch (e: any) {
        logger.error({ err: e }, "Candidate location selection rendering failed");
        await ScreenManager.renderScreen(ctx, "🐾 Ой! Виникла помилка при завантаженні локацій. Спробуй /start ще раз.");
    }
}

export async function handleNoVacancies(ctx: MyContext, city: string) {
    const bdStr = ctx.session.candidateData.birthDate;
    const birthDate = bdStr ? new Date(bdStr) : new Date();

    if (ctx.session.candidateData.gender === "male") {
        await persistCandidate(ctx, {
            fullName: ctx.session.candidateData.fullName,
            birthDate,
            gender: ctx.session.candidateData.gender,
            city,
            status: CandidateStatus.REJECTED,
            isWaitlisted: false
        });
        ctx.session.step = "idle";
        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-reject-male-location"](city, city));
        return;
    }

    const ageMeta = getAgeRejectionMeta(getCandidateAge(birthDate));

    await persistCandidate(ctx, {
        fullName: ctx.session.candidateData.fullName,
        birthDate,
        gender: ctx.session.candidateData.gender,
        city,
        status: ageMeta.status,
        isWaitlisted: ageMeta.isWaitlisted,
        hrDecision: ageMeta.hrDecision
    });

    logger.info({
        event: "candidate.screening.completed",
        correlation_id: ctx.correlationId,
        update_id: ctx.update.update_id,
        telegram_id: ctx.from?.id != null ? String(ctx.from.id) : undefined,
        stage: "SCREENING",
        result: ageMeta.status === CandidateStatus.REJECTED ? "rejected" : "waitlisted",
        reason_code: ageMeta.reasonCode,
        safe_context: { city, status: ageMeta.status }
    }, "Candidate screening completed with no vacancies");

    if (ageMeta.status === CandidateStatus.REJECTED) {
        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS[ageMeta.finalKey]);
    } else {
        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-info-no-vacancies"](city));
    }
    ctx.session.step = "idle";
}

async function triggerPrompt(ctx: MyContext, step: string) {
    if (step === "screening_city") {
        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-ask-city"], "candidate-city", { pushToStack: true });
    } else if (step === "screening_location") {
        await renderLocationSelection(ctx);
    } else if (step === "screening_source") {
        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-ask-source"], "candidate-source", { pushToStack: true });
    }
}

// --- HANDLERS ---

export const candidateHandlers = new Composer<MyContext>();

candidateHandlers.callbackQuery("resume_screening", async (ctx) => {
    const { userRepository, candidateRepository } = ctx.di;
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = await userRepository.findWithCandidateProfileByTelegramId(BigInt(userId));
    if (!user?.candidate) return;

    await ctx.answerCallbackQuery();

    // Fill session with existing data
    ctx.session.candidateData = {
        fullName: user.candidate.fullName,
        gender: user.candidate.gender,
        birthDate: user.candidate.birthDate?.toISOString(),
        city: user.candidate.city,
        locationIds: user.candidate.locationId ? [user.candidate.locationId] : [],
        appearance: user.candidate.appearance,
        source: user.candidate.source,
        clickSource: user.candidate.clickSource
    } as any;

    await startScreening(ctx);
});

candidateHandlers.callbackQuery("restart_screening", async (ctx) => {
    const { userRepository, candidateRepository } = ctx.di;
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = await userRepository.findWithCandidateProfileByTelegramId(BigInt(userId));

    if (user?.candidate) {
        await candidateRepository.update(user.candidate.id, {
            fullName: null,
            gender: null,
            birthDate: null,
            city: null,
            location: { disconnect: true },
            appearance: null,
            source: null,
            clickSource: null,
            status: CandidateStatus.SCREENING,
            currentStep: FunnelStep.INITIAL_TEST
        });
    }

    await ctx.answerCallbackQuery("Починаємо спочатку! ✨");
    ctx.session.candidateData = {};
    await startScreening(ctx);
});

candidateHandlers.callbackQuery("candidate_start_screening", async (ctx) => {
    const { userRepository, candidateRepository } = ctx.di;
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = await userRepository.findWithCandidateProfileByTelegramId(BigInt(userId));

    // GUARD: If candidate already passed screening, don't allow reset via old buttons
    if (user?.candidate) {
        const protectedStatuses: CandidateStatus[] = [
            CandidateStatus.ACCEPTED,
            CandidateStatus.INTERVIEW_SCHEDULED,
            CandidateStatus.INTERVIEW_COMPLETED,
            CandidateStatus.TRAINING_SCHEDULED,
            CandidateStatus.TRAINING_COMPLETED,
            CandidateStatus.OFFLINE_STAGING,
            CandidateStatus.AWAITING_FIRST_SHIFT,
            CandidateStatus.HIRED
        ];

        if (protectedStatuses.includes(user.candidate.status)) {
            await ctx.answerCallbackQuery("⚠️ Твій профіль уже в роботі! Анкета не потребує оновлення. ✨");
            const { showCandidateStatus } = await import("../../../utils/candidate-ui.js");
            await showCandidateStatus(ctx, user.candidate);
            return;
        }

        // Allow reset only for new or rejected candidates
        await candidateRepository.update(user.candidate.id, {
            currentStep: FunnelStep.INITIAL_TEST,
            fullName: null,
            city: null,
            location: { disconnect: true },
            appearance: null
        });
    }

    await ctx.answerCallbackQuery();
    ctx.session.candidateData = {};
    await startScreening(ctx);
});

candidateHandlers.on("message:text", async (ctx, next) => {
    const step = ctx.session.step;
    if (ctx.message.text.startsWith("/")) return next();

    // SMI: Delete user message immediately
    await ctx.deleteMessage().catch(() => { });

    if (step === "screening_name") {
        const val = CandidateSchema.shape.fullName.safeParse(ctx.message.text);
        if (val.success) {
            ctx.session.candidateData.fullName = val.data;
            ctx.session.step = "screening_gender";
            await persistCandidate(ctx, { fullName: val.data, currentStep: FunnelStep.INITIAL_TEST });
            const firstName = extractFirstName(val.data);
            await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-greeting-nicetomeet"](firstName), "candidate-gender", { pushToStack: true });
        } else {
            const errorText = CANDIDATE_TEXTS["error-name-format"](val.error.issues[0]?.message || "Помилка");
            await ScreenManager.renderScreen(ctx, errorText + "\n\n" + CANDIDATE_TEXTS["ask-name"]);
        }
        return;
    } else if (step === "screening_other_city") {
        const text = ctx.message.text.trim();
        if (!/^[a-zA-Zа-яА-ЯіїєІЇЄ\s-]+$/.test(text) || text.length < 2) {
            await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-error-city-invalid"] + "\n\n" + CANDIDATE_TEXTS["candidate-ask-other-city-name"]);
            return;
        }

        const { locationRepository } = ctx.di;
        const activeCities = await locationRepository.findAllCities(true, true);
        const existing = activeCities.find((c: string) => c.toLowerCase() === text.toLowerCase());
        if (existing) {
            await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-error-city-already-exists"](existing) + "\n\n" + CANDIDATE_TEXTS["candidate-ask-other-city-name"]);
            return;
        }

        const normalizedCity = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();

        const bdStr = ctx.session.candidateData.birthDate;
        const birthDate = bdStr ? new Date(bdStr) : new Date();

        if (ctx.session.candidateData.gender === "male") {
            await persistCandidate(ctx, {
                fullName: ctx.session.candidateData.fullName,
                birthDate,
                gender: ctx.session.candidateData.gender,
                city: normalizedCity,
                status: CandidateStatus.REJECTED,
                isWaitlisted: false,
                isOtherCity: true
            });
            await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-reject-male-location"](normalizedCity, normalizedCity));
            ctx.session.step = "idle";
            return;
        }

        const ageMeta = getAgeRejectionMeta(getCandidateAge(birthDate));

        await persistCandidate(ctx, {
            fullName: ctx.session.candidateData.fullName,
            birthDate,
            gender: ctx.session.candidateData.gender,
            city: normalizedCity,
            status: ageMeta.status,
            isWaitlisted: ageMeta.isWaitlisted,
            hrDecision: ageMeta.hrDecision,
            isOtherCity: true
        });

        if (ageMeta.status === CandidateStatus.REJECTED) {
            await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS[ageMeta.finalKey]);
        } else {
            await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-success-other-city"](normalizedCity));
        }
        ctx.session.step = "idle";
        return;
    } else if (step === "screening_birthdate") {
        const text = ctx.message.text;
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(text)) {
            const [d, m, y] = text.split(".").map(Number);
            const date = new Date(y!, m! - 1, d!);
            if (!isNaN(date.getTime()) && date.getDate() === d) {
                const val = CandidateSchema.shape.birthDate.safeParse(date);
                if (val.success) {
                    ctx.session.candidateData.birthDate = date.toISOString();
                    await persistCandidate(ctx, { birthDate: date });

                    if (shouldDeferCandidateAtBirthDate(date)) {
                        await persistCandidate(ctx, {
                            fullName: ctx.session.candidateData.fullName,
                            birthDate: date,
                            gender: ctx.session.candidateData.gender,
                            status: CandidateStatus.REJECTED,
                            isWaitlisted: false,
                            hrDecision: "REJECTED_SYSTEM_UNDERAGE"
                        });
                        ctx.session.step = "idle";
                        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-reject-underage"]);
                        return;
                    }

                    ctx.session.step = "screening_city";
                    await triggerPrompt(ctx, "screening_city");
                } else {
                    await ScreenManager.renderScreen(ctx, `⚠️ ${val.error.issues[0]?.message}\n\n${CANDIDATE_TEXTS["candidate-ask-birthday"]}`);
                }
            } else {
                await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-error-birthday-invalid"]);
            }
        } else {
            await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-error-birthday-invalid"]);
        }
        return;
    } else if (step === "screening_appearance") {
        await finishScreening(ctx, ctx.message.text);
        return;
    }

    await next();
});

candidateHandlers.on("message:photo", async (ctx) => {
    if (ctx.session.step === "screening_appearance") {
        const photo = ctx.message.photo.pop();
        if (photo) {
            await finishScreening(ctx, "[Фото]", photo.file_id);
        }
    } else if (ctx.session.step?.startsWith("screening_")) {
        await ScreenManager.renderScreen(ctx, "📝 Будь ласка, надішли текстову відповідь, а не фото. ✨");
    }
});

export async function handleLocationSelected(ctx: MyContext, targetLoc: any, city: string) {
    const { fullName, birthDate: bdStr, gender } = ctx.session.candidateData;
    const birthDate = bdStr ? new Date(bdStr) : new Date(0);
    const finalLocationId = getLocationIds(ctx.session.candidateData)[0];

    if (gender === "male") {
        await persistCandidate(ctx, { fullName, birthDate, gender, city, locationId: finalLocationId, status: CandidateStatus.REJECTED });
        ctx.session.step = "idle";
        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-reject-male-location"](targetLoc?.name || city, city));
        return;
    }

    const ageMeta = getAgeRejectionMeta(getCandidateAge(birthDate), targetLoc);
    if (ageMeta.status === CandidateStatus.REJECTED) {
        await persistCandidate(ctx, {
            fullName,
            birthDate,
            gender,
            city,
            locationId: finalLocationId,
            status: CandidateStatus.REJECTED,
            isWaitlisted: false,
            hrDecision: ageMeta.hrDecision
        });
        ctx.session.step = "idle";
        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS[ageMeta.finalKey]);
        return;
    }

    await persistCandidate(ctx, { city, locationId: finalLocationId });
    ctx.session.step = "screening_appearance_prompt";
    await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-ask-appearance"], "candidate-appearance");
}

export async function finishScreening(ctx: MyContext, appearance: string, tattooPhotoId?: string) {
    const { locationRepository, candidateRepository } = ctx.di;

    ctx.session.candidateData.appearance = appearance;
    if (tattooPhotoId) ctx.session.candidateData.tattooPhotoId = tattooPhotoId;
    await persistCandidate(ctx, { appearance, ...(tattooPhotoId ? { tattooPhotoId } : {}) });

    if (!ctx.session.candidateData.source) {
        ctx.session.step = "screening_source";
        await triggerPrompt(ctx, "screening_source");
        return;
    }

    // SMI: Update current message to processing instead of sending a new one
    await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-info-processing"]);

    const { fullName, birthDate: bdStr, gender, city, source, clickSource, tattooPhotoId: finalTattooId } = ctx.session.candidateData;
    const locationIds = getLocationIds(ctx.session.candidateData);
    const birthDate = new Date(bdStr!);
    let status: CandidateStatus = CandidateStatus.SCREENING;
    let isWaitlisted = false;
    let finalLocationId = locationIds.length > 0 ? locationIds[0] : undefined;
    const selectedLocs = await Promise.all((locationIds || []).map((id: string) => locationRepository.findById(id!)));

    let hrDecision: string | null = null;
    const age = getCandidateAge(birthDate);
    const primaryLocationForAge = selectedLocs.find((l: any) => l?.id === finalLocationId) || selectedLocs[0];
    const ageRejection = getAgeRejection(age, primaryLocationForAge);

    if (ageRejection === "UNDERAGE") {
        status = CandidateStatus.REJECTED;
        hrDecision = "REJECTED_SYSTEM_UNDERAGE";
    } else if (ageRejection === "AGE_LIMIT") {
        status = CandidateStatus.REJECTED;
        hrDecision = "AGE_LIMIT";
    } else {
        const ageEligibleLocs = selectedLocs.filter((l: any) => l && getAgeRejection(age, l) === null);
        const availableLoc = ageEligibleLocs.find((l: any) => l.neededCount > 0);
        if (availableLoc) {
            finalLocationId = availableLoc.id;
            status = CandidateStatus.SCREENING;
        } else {
            if (ageEligibleLocs.length > 0 && ageEligibleLocs[0]) finalLocationId = ageEligibleLocs[0].id;
            status = CandidateStatus.WAITLIST_HR;
            isWaitlisted = true;
        }

        if (status === CandidateStatus.SCREENING && (appearance.includes("[Фото]") || appearance !== "Без особливостей")) {
            status = CandidateStatus.MANUAL_REVIEW;
        }
    }

    const locNames = (await Promise.all((locationIds || []).map(async (id: string) => {
        const l = await locationRepository.findById(id);
        return l?.name;
    }))).filter(Boolean).join(', ');

    if (gender === "male") {
        await persistCandidate(ctx, {
            fullName,
            birthDate,
            gender,
            city,
            locationId: finalLocationId,
            source,
            clickSource,
            appearance: appearance + (locationIds && locationIds.length > 1 ? `\n(Обрані локації: ${locNames})` : ""),
            tattooPhotoId: finalTattooId,
            status: CandidateStatus.REJECTED,
            isWaitlisted: false,
            hrDecision: null
        });
        ctx.session.step = "idle";
        await ScreenManager.renderScreen(
            ctx,
            CANDIDATE_TEXTS["candidate-reject-male-location"](
                primaryLocationForAge?.name || city || "цій локації",
                city || "вашому місті"
            )
        );
        return;
    }

    await persistCandidate(ctx, {
        fullName,
        birthDate,
        gender,
        city,
        locationId: finalLocationId,
        source,
        clickSource,
        appearance: appearance + (locationIds && locationIds.length > 1 ? `\n(Обрані локації: ${locNames})` : ""),
        tattooPhotoId: finalTattooId,
        status,
        isWaitlisted,
        hrDecision
    });

    logger.info({
        event: "candidate.screening.completed",
        correlation_id: ctx.correlationId,
        update_id: ctx.update.update_id,
        telegram_id: ctx.from?.id != null ? String(ctx.from.id) : undefined,
        stage: "SCREENING",
        result: "success",
        reason_code:
            status === CandidateStatus.REJECTED && hrDecision === "AGE_LIMIT" ? "AGE_LIMIT" :
            status === CandidateStatus.REJECTED ? "UNDERAGE" :
            status === CandidateStatus.MANUAL_REVIEW ? "MANUAL_REVIEW" :
            status === CandidateStatus.WAITLIST_HR ? "NO_CAPACITY" :
            "READY_FOR_INTERVIEW",
        safe_context: {
            city,
            locationId: finalLocationId,
            status,
            isWaitlisted,
            currentStep: "INITIAL_TEST"
        }
    }, "Candidate screening finalized");

    // Notify HR if needed
    if (status === CandidateStatus.MANUAL_REVIEW || status === CandidateStatus.WAITLIST_HR) {
        try {
            const { HR_IDS } = await import("../../../config.js");
            if (HR_IDS && HR_IDS.length > 0) {
                const name = fullName || ctx.from?.first_name || "Candidate";
                const username = ctx.from?.username ? `@${ctx.from.username}` : "No username";
                const alertMsg = `⚠️ <b>INBOX: New ${status === CandidateStatus.MANUAL_REVIEW ? 'Manual Review' : 'Waitlist'}</b>\n\n👤 Candidate: <b>${name}</b>\n🏙️ City: <b>${city}</b>\n📱 Username: ${username}\n\n<i>Reason: ${status === CandidateStatus.MANUAL_REVIEW ? 'Tattoo review' : 'Team is full'}</i>`;
                const kb = new InlineKeyboard().text("👤 View Profile", `view_candidate_new_${ctx.from?.id}`);

                for (const hrId of HR_IDS) {
                    try {
                        if (status === CandidateStatus.MANUAL_REVIEW && finalTattooId) {
                            await ctx.api.sendPhoto(hrId, finalTattooId, { caption: alertMsg, parse_mode: "HTML", reply_markup: kb });
                        } else {
                            await ctx.api.sendMessage(hrId, alertMsg, { parse_mode: "HTML", reply_markup: kb });
                        }
                    } catch (e) { }
                }
            }
        } catch (e) { }
    }

    ctx.session.step = "idle";
    const finalKey = status === CandidateStatus.REJECTED && hrDecision === "AGE_LIMIT" ? "candidate-reject-age-limit" :
        status === CandidateStatus.REJECTED ? "candidate-reject-underage" :
        status === CandidateStatus.MANUAL_REVIEW ? "candidate-success-manual-review" :
            status === CandidateStatus.WAITLIST_HR ? "candidate-success-waitlist" :
                "candidate-success-screening";

    await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS[finalKey]);
}

candidateHandlers.on("callback_query:data", async (ctx, next) => {
    const candId = readCallbackPayload(ctx.callbackQuery.data, { code: "cstg" });
    if (!candId) return next();
    await ctx.answerCallbackQuery();
    try {
        const { hrService } = await import("../../../services/hr-service.js");
        const cand = await hrService.getCandidateDetails(candId);
        if (!cand) return;
        if (Number(cand.user.telegramId) !== ctx.from?.id) {
            await ctx.answerCallbackQuery("Ця дія недоступна.");
            return;
        }

        // Guard: only allow cancellation for candidates still in setup/active phase
        if (cand.status !== CandidateStatus.STAGING_SETUP && cand.status !== CandidateStatus.STAGING_ACTIVE) {
            return;
        }

        await hrService.cancelCandidateStaging(ctx.api, candId);
        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["staging-cancelled-by-candidate"]);
    } catch (e) {
        const { default: logger } = await import("../../../core/logger.js");
        logger.error({ err: e, candId }, "Candidate staging cancellation failed");
        await ctx.reply("⚠️ Щось пішло не так. Спробуй ще раз або напиши адміну.");
    }
});
