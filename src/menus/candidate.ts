import { Menu } from "@grammyjs/menu";
import { formatLocation } from "../utils/location-label.js";
import type { MyContext } from "../types/context.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { locationRepository } from "../repositories/location-repository.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { CandidateStatus } from "@prisma/client";
import { ScreenManager } from "../utils/screen-manager.js";
import { menuRegistry } from "../utils/menu-registry.js";
import { BIRTH_MONTH_LABELS, getDaysInMonth, getSelectableBirthDecades, getSelectableBirthYears, getYearsInDecade } from "../utils/birth-date-picker.js";

// --- CANDIDATE FUNNEL MENUS ---

export const candidateGenderMenu = new Menu<MyContext>("candidate-gender");
menuRegistry.register(candidateGenderMenu);

candidateGenderMenu
    .text(CANDIDATE_TEXTS["candidate-btn-gender-female"], async (ctx) => {
        ctx.session.candidateData.gender = "female";
        const { persistCandidate } = await import("../modules/candidate/handlers/index.js");
        await persistCandidate(ctx, { gender: "female" });
        await askBirthYear(ctx);
    })
    .text(CANDIDATE_TEXTS["candidate-btn-gender-male"], async (ctx) => {
        ctx.session.candidateData.gender = "male";
        const { persistCandidate } = await import("../modules/candidate/handlers/index.js");
        await persistCandidate(ctx, { gender: "male" });
        await askBirthYear(ctx);
    })
    .row()
    .text("Назад", async (ctx) => {
        // Крок імені — вільний ввід без клавіатури, тож у стек він не
        // потрапляє і goBack не має куди повернутись. Ставимо крок явно,
        // інакше введене ім'я нікуди не запишеться.
        ctx.session.step = "screening_name";
        await ScreenManager.goBack(ctx, CANDIDATE_TEXTS["ask-name"]);
    });

// --- ДАТА НАРОДЖЕННЯ: РІК → МІСЯЦЬ → ДЕНЬ ---
// Три екрани кнопок замість ручного вводу ДД.ММ.РРРР. Обґрунтування вибору
// саме повної дати, а не лише року — в utils/birth-date-picker.ts.

async function askBirthYear(ctx: MyContext) {
    ctx.session.step = "screening_birth_year";
    delete ctx.session.candidateData.birthYear;
    delete ctx.session.candidateData.birthMonth;
    delete ctx.session.candidateData.birthDecade;
    await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-ask-birth-year"], "candidate-birth-year", { pushToStack: true });
}

export const candidateBirthYearMenu = new Menu<MyContext>("candidate-birth-year");
menuRegistry.register(candidateBirthYearMenu);

async function selectBirthYear(ctx: MyContext, year: number) {
    ctx.session.candidateData.birthYear = year;
    ctx.session.step = "screening_birth_month";
    await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-ask-birth-month"](year), "candidate-birth-month", { pushToStack: true });
}

candidateBirthYearMenu.dynamic((_ctx, range) => {
    const years = getSelectableBirthYears();
    years.forEach((year, i) => {
        range.text(String(year), (ctx) => selectBirthYear(ctx, year));
        if ((i + 1) % 3 === 0) range.row();
    });

    // Короткий список покриває лише вік, з яким беруть у команду. Людина поза
    // ним раніше не могла вказати свій рік узагалі — кнопки не існувало.
    range.row().text(CANDIDATE_TEXTS["candidate-btn-birth-year-other"], async (ctx) => {
        ctx.session.step = "screening_birth_decade";
        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-ask-birth-decade"], "candidate-birth-decade", { pushToStack: true });
    });
    range.row().text("Назад", (ctx) => ScreenManager.goBack(ctx, CANDIDATE_TEXTS["candidate-greeting-nicetomeet"](), "candidate-gender"));
});

export const candidateBirthDecadeMenu = new Menu<MyContext>("candidate-birth-decade");
menuRegistry.register(candidateBirthDecadeMenu);

candidateBirthDecadeMenu.dynamic((_ctx, range) => {
    const decades = getSelectableBirthDecades();
    decades.forEach((decade, i) => {
        range.text(`${decade}-ті`, async (ctx) => {
            ctx.session.candidateData.birthDecade = decade;
            ctx.session.step = "screening_birth_year_in_decade";
            await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-ask-birth-year-in-decade"](decade), "candidate-birth-year-in-decade", { pushToStack: true });
        });
        if ((i + 1) % 3 === 0) range.row();
    });
    range.row().text("Назад", (ctx) => ScreenManager.goBack(ctx, CANDIDATE_TEXTS["candidate-ask-birth-year"], "candidate-birth-year"));
});

export const candidateBirthYearInDecadeMenu = new Menu<MyContext>("candidate-birth-year-in-decade");
menuRegistry.register(candidateBirthYearInDecadeMenu);

candidateBirthYearInDecadeMenu.dynamic((ctx, range) => {
    const decade = ctx.session.candidateData.birthDecade;
    if (!decade) return;

    getYearsInDecade(decade).forEach((year, i) => {
        range.text(String(year), (ctx) => selectBirthYear(ctx, year));
        if ((i + 1) % 3 === 0) range.row();
    });
    range.row().text("Назад", (ctx) => ScreenManager.goBack(ctx, CANDIDATE_TEXTS["candidate-ask-birth-decade"], "candidate-birth-decade"));
});

export const candidateBirthMonthMenu = new Menu<MyContext>("candidate-birth-month");
menuRegistry.register(candidateBirthMonthMenu);

candidateBirthMonthMenu.dynamic((ctx, range) => {
    const year = ctx.session.candidateData.birthYear;
    if (!year) return;

    BIRTH_MONTH_LABELS.forEach((label, index) => {
        const month = index + 1;
        range.text(label, async (ctx) => {
            ctx.session.candidateData.birthMonth = month;
            ctx.session.step = "screening_birth_day";
            await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-ask-birth-day"](year, label), "candidate-birth-day", { pushToStack: true });
        });
        // По двоє в рядок: «Березень», «Листопад», «Вересень» — по вісім
        // символів, і три такі кнопки поруч обрізаються на вузькому екрані.
        if ((index + 1) % 2 === 0) range.row();
    });
    range.row().text("Назад", (ctx) => ScreenManager.goBack(ctx, CANDIDATE_TEXTS["candidate-ask-birth-year"], "candidate-birth-year"));
});

export const candidateBirthDayMenu = new Menu<MyContext>("candidate-birth-day");
menuRegistry.register(candidateBirthDayMenu);

candidateBirthDayMenu.dynamic((ctx, range) => {
    const { birthYear: year, birthMonth: month } = ctx.session.candidateData;
    if (!year || !month) return;

    const daysInMonth = getDaysInMonth(year, month);
    for (let day = 1; day <= daysInMonth; day++) {
        const chosenDay = day;
        range.text(String(day), async (ctx) => {
            const { handleBirthDateSelected } = await import("../modules/candidate/handlers/index.js");
            await handleBirthDateSelected(ctx, chosenDay);
        });
        if (day % 7 === 0) range.row();
    }
    range.row().text("Назад", (ctx) => ScreenManager.goBack(ctx, CANDIDATE_TEXTS["candidate-ask-birth-month"](year), "candidate-birth-month"));
});

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
        // Одне місто в рядок. По двоє назви на кшталт «Хмельницький» (12
        // символів) обрізалися на вузькому екрані, а обрізана назва міста —
        // це не косметика, а ризик обрати не те. Міст близько десятка, тож
        // вертикальний список лишається оглядним.
        range.row();
    });
    range.row().text("Назад", async (ctx) => {
        // Крок імені — вільний ввід без клавіатури, тож у стек він не
        // потрапляє і goBack не має куди повернутись. Ставимо крок явно,
        // інакше введене ім'я нікуди не запишеться.
        ctx.session.step = "screening_name";
        await ScreenManager.goBack(ctx, CANDIDATE_TEXTS["ask-name"]);
    });
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
        // Позначка вибору — єдиний спосіб показати стан у множинному виборі.
        // Символ, а не емодзі: тримається однорідно з рештою кнопок.
        const label = `${isSelected ? '• ' : ''}${formatLocation(l, "in-city")}`;
        
        range.text(label, async (ctx) => {
            if (selectedIds.has(l.id)) selectedIds.delete(l.id);
            else selectedIds.add(l.id);
            ctx.session.candidateData.locationIds = Array.from(selectedIds);
            await ctx.menu.update();
        });
        // Одна локація в рядок: назви на кшталт «Smile Park (Даринок)» довгі,
        // а позначка вибору «• » ще й зсуває хвіст за край кнопки.
        range.row();
    });

    if (selectedIds.size > 0) {
        range.row().text("Готово", async (ctx) => {
            const primaryLocId = Array.from(selectedIds)[0];
            const targetLoc = await locationRepository.findById(primaryLocId!);
            const { handleLocationSelected } = await import("../modules/candidate/handlers/index.js");
            await handleLocationSelected(ctx, targetLoc, city);
        });
    }
    range.row().text("Назад", (ctx) => ScreenManager.goBack(ctx, CANDIDATE_TEXTS["candidate-ask-city"], "candidate-city"));
});

export const candidateAppearanceDetailsMenu = new Menu<MyContext>("candidate-appearance-details");
menuRegistry.register(candidateAppearanceDetailsMenu);

candidateAppearanceDetailsMenu.text("Назад", async (ctx) => {
    ctx.session.step = "screening_appearance_prompt";
    await ScreenManager.goBack(ctx, CANDIDATE_TEXTS["candidate-ask-appearance"], "candidate-appearance");
});

export const candidateAppearanceMenu = new Menu<MyContext>("candidate-appearance");
menuRegistry.register(candidateAppearanceMenu);

candidateAppearanceMenu
    .text(CANDIDATE_TEXTS["candidate-btn-appr-no"], async (ctx) => {
        const { finishScreening } = await import("../modules/candidate/handlers/index.js");
        await finishScreening(ctx, CANDIDATE_TEXTS["candidate-val-appearance-none"]);
    })
    // Крок з вільним вводом, але вже не глухий кут: клавіатура з «Назад»
    // дозволяє передумати й повернутися до питання про зовнішність. Раніше
    // екран малювався без клавіатури, а pushToStack на ньому мовчки не
    // спрацьовував — вийти можна було тільки через /start.
    .text(CANDIDATE_TEXTS["candidate-btn-appr-yes"], async (ctx) => {
        ctx.session.step = "screening_appearance";
        await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-ask-appearance-details"], "candidate-appearance-details", { pushToStack: true });
    })
    .row()
    .text("Назад", async (ctx) => {
        // Міст назад до вибору локації. Якщо в місті одна локація, того
        // екрана не було — тоді goBack по стеку веде до списку міст.
        ctx.session.step = "screening_location";
        await ScreenManager.goBack(ctx, CANDIDATE_TEXTS["candidate-ask-city"], "candidate-city");
    });

/**
 * Захист від подвійного тапу. Без fingerprint плагін звіряє лише позицію
 * кнопки й не відрізняє повторний тап від першого: на повільній мережі людина
 * тисне «Instagram» удруге, і finishScreening відпрацьовує двічі — два проходи
 * по БД і друга відмальовка поверх результату.
 *
 * Ключ — крок анкети. Щойно finishScreening ставить step = "idle", стара
 * клавіатура стає недійсною і другий тап до обробника не доходить. Значення
 * стабільне доти, доки екран справді актуальний, тож хибних «меню застаріло»
 * тут не буде — на відміну від динамічних списків міст і локацій, яким
 * fingerprint навмисно не заданий.
 */
export const candidateSourceMenu = new Menu<MyContext>("candidate-source", {
    fingerprint: (ctx) => `source:${ctx.session.step ?? "none"}`,
});
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
    .text("Назад", (ctx) => ScreenManager.goBack(ctx, CANDIDATE_TEXTS["candidate-ask-appearance"], "candidate-appearance"));

// --- REGISTRATION ---
// We use a hierarchical structure to allow ctx.menu.nav() to work correctly
// and ensure all buttons are 'live' within the same context.
export const candidateRootMenu = new Menu<MyContext>("candidate-root");
menuRegistry.register(candidateRootMenu);
candidateRootMenu.register(candidateGenderMenu);
candidateRootMenu.register(candidateBirthYearMenu);
candidateRootMenu.register(candidateBirthDecadeMenu);
candidateRootMenu.register(candidateBirthYearInDecadeMenu);
candidateRootMenu.register(candidateBirthMonthMenu);
candidateRootMenu.register(candidateBirthDayMenu);
candidateRootMenu.register(candidateCityMenu);
candidateRootMenu.register(candidateLocationMenu);
candidateRootMenu.register(candidateAppearanceMenu);
candidateRootMenu.register(candidateAppearanceDetailsMenu);
candidateRootMenu.register(candidateSourceMenu);

// Note: onboardingConfirmBirthDateMenu is registered in onboarding-handler.ts 
// and used via ScreenManager.renderScreen with its own registration.
