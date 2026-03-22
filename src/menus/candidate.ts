import { Menu } from "@grammyjs/menu";
import type { MyContext } from "../types/context.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { locationRepository } from "../repositories/location-repository.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { CandidateStatus } from "@prisma/client";
import { ScreenManager } from "../utils/screen-manager.js";
import { menuRegistry } from "../utils/menu-registry.js";

// --- CANDIDATE FUNNEL MENUS ---

export const candidateGenderMenu = new Menu<MyContext>("candidate-gender");
menuRegistry.register(candidateGenderMenu);

candidateGenderMenu
    .text(CANDIDATE_TEXTS["candidate-btn-gender-female"], async (ctx) => {
        ctx.session.candidateData.gender = "female";
        ctx.session.step = "screening_birthdate";
        const { persistCandidate } = await import("../modules/candidate/handlers/index.js");
        await persistCandidate(ctx, { gender: "female" });
        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-ask-birthday"], undefined, { pushToStack: true });
    })
    .text(CANDIDATE_TEXTS["candidate-btn-gender-male"], async (ctx) => {
        ctx.session.candidateData.gender = "male";
        ctx.session.step = "screening_birthdate";
        const { persistCandidate } = await import("../modules/candidate/handlers/index.js");
        await persistCandidate(ctx, { gender: "male" });
        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-ask-birthday"], undefined, { pushToStack: true });
    })
    .row()
    .text("⬅️ Назад", (ctx) => ScreenManager.goBack(ctx, CANDIDATE_TEXTS["ask-name"]));

export const candidateCityMenu = new Menu<MyContext>("candidate-city");
menuRegistry.register(candidateCityMenu);

candidateCityMenu.dynamic(async (ctx, range) => {
    const cities = await locationRepository.findAllCities(true, true);
    cities.forEach((city, i) => {
        range.text(city, async (ctx) => {
            ctx.session.candidateData.city = city;
            ctx.session.candidateData.locationIds = [];
            const { persistCandidate } = await import("../modules/candidate/handlers/index.js");
            await persistCandidate(ctx, { city });

            const locations = await locationRepository.findByCity(city, true);
            if (locations.length === 0) {
                const { handleNoVacancies } = await import("../modules/candidate/handlers/index.js");
                await handleNoVacancies(ctx, city);
            } else if (locations.length === 1) {
                const targetLoc = locations[0]!;
                ctx.session.candidateData.locationIds = [targetLoc.id];
                const { handleLocationSelected } = await import("../modules/candidate/handlers/index.js");
                await handleLocationSelected(ctx, targetLoc, city);
            } else {
                ctx.session.step = "screening_location";
                const { renderLocationSelectionContent } = await import("../modules/candidate/handlers/index.js");
                const { text, kb } = await renderLocationSelectionContent(ctx);
                await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true });
            }
        });
        if ((i + 1) % 2 === 0) range.row();
    });
    range.row().text(CANDIDATE_TEXTS["candidate-btn-city-other"], async (ctx) => {
        ctx.session.step = "screening_other_city";
        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-ask-other-city-name"], undefined, { pushToStack: true });
    });
    range.row().text("⬅️ Назад", (ctx) => ScreenManager.goBack(ctx, CANDIDATE_TEXTS["ask-name"]));
});

export const candidateLocationMenu = new Menu<MyContext>("candidate-location");
menuRegistry.register(candidateLocationMenu);

candidateLocationMenu.dynamic(async (ctx, range) => {
    const city = ctx.session.candidateData.city;
    if (!city) return;
    
    const locations = await locationRepository.findByCity(city, true);
    const selectedIds = new Set(ctx.session.candidateData.locationIds || []);

    locations.forEach((l, i) => {
        const isSelected = selectedIds.has(l.id);
        const label = `${isSelected ? '✅ ' : ''}${l.name}`;
        
        range.text(label, async (ctx) => {
            if (selectedIds.has(l.id)) selectedIds.delete(l.id);
            else selectedIds.add(l.id);
            ctx.session.candidateData.locationIds = Array.from(selectedIds);
            await ctx.menu.update();
        });
        if ((i + 1) % 2 === 0) range.row();
    });

    if (selectedIds.size > 0) {
        range.row().text("✨ Готово", async (ctx) => {
            const primaryLocId = Array.from(selectedIds)[0];
            const targetLoc = await locationRepository.findById(primaryLocId!);
            const { handleLocationSelected } = await import("../modules/candidate/handlers/index.js");
            await handleLocationSelected(ctx, targetLoc, city);
        });
    }
    range.row().text("⬅️ Назад", (ctx) => ScreenManager.goBack(ctx, CANDIDATE_TEXTS["candidate-ask-city"], "candidate-city"));
});

export const candidateAppearanceMenu = new Menu<MyContext>("candidate-appearance");
menuRegistry.register(candidateAppearanceMenu);

candidateAppearanceMenu
    .text(CANDIDATE_TEXTS["candidate-btn-appr-no"], async (ctx) => {
        const { finishScreening } = await import("../modules/candidate/handlers/index.js");
        await finishScreening(ctx, CANDIDATE_TEXTS["candidate-val-appearance-none"]);
    })
    .text(CANDIDATE_TEXTS["candidate-btn-appr-yes"], async (ctx) => {
        ctx.session.step = "screening_appearance";
        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-ask-appearance-details"], undefined, { pushToStack: true });
    })
    .row()
    .text("⬅️ Назад", (ctx) => ScreenManager.goBack(ctx, CANDIDATE_TEXTS["candidate-ask-location-multiple"]));

export const candidateSourceMenu = new Menu<MyContext>("candidate-source");
menuRegistry.register(candidateSourceMenu);

candidateSourceMenu
    .text(CANDIDATE_TEXTS["candidate-btn-source-instagram"], async (ctx) => {
        ctx.session.candidateData.source = "Instagram";
        const { finishScreening } = await import("../modules/candidate/handlers/index.js");
        await finishScreening(ctx, ctx.session.candidateData.appearance || "Без особливостей");
    })
    .text(CANDIDATE_TEXTS["candidate-btn-source-workua"], async (ctx) => {
        ctx.session.candidateData.source = "Work.ua";
        const { finishScreening } = await import("../modules/candidate/handlers/index.js");
        await finishScreening(ctx, ctx.session.candidateData.appearance || "Без особливостей");
    })
    .row()
    .text(CANDIDATE_TEXTS["candidate-btn-source-olx"], async (ctx) => {
        ctx.session.candidateData.source = "OLX";
        const { finishScreening } = await import("../modules/candidate/handlers/index.js");
        await finishScreening(ctx, ctx.session.candidateData.appearance || "Без особливостей");
    })
    .text(CANDIDATE_TEXTS["candidate-btn-source-other"], async (ctx) => {
        ctx.session.candidateData.source = "Other";
        const { finishScreening } = await import("../modules/candidate/handlers/index.js");
        await finishScreening(ctx, ctx.session.candidateData.appearance || "Без особливостей");
    })
    .row()
    .text("⬅️ Назад", (ctx) => ScreenManager.goBack(ctx, CANDIDATE_TEXTS["candidate-ask-appearance"], "candidate-appearance"));

// --- REGISTRATION ---
// We use a hierarchical structure to allow ctx.menu.nav() to work correctly
// and ensure all buttons are 'live' within the same context.
export const candidateRootMenu = new Menu<MyContext>("candidate-root");
menuRegistry.register(candidateRootMenu);
candidateRootMenu.register(candidateGenderMenu);
candidateRootMenu.register(candidateCityMenu);
candidateRootMenu.register(candidateLocationMenu);
candidateRootMenu.register(candidateAppearanceMenu);
candidateRootMenu.register(candidateSourceMenu);

// Note: onboardingConfirmBirthDateMenu is registered in onboarding-handler.ts 
// and used via ScreenManager.renderScreen with its own registration.
