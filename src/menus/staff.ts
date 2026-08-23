import { Menu } from "@grammyjs/menu";
import type { MyContext } from "../types/context.js";
import { menuRegistry } from "../utils/menu-registry.js";
import { getStaffShiftToday } from "../modules/staff/services/staff-today-shift.js";
import { BUSINESS_DATA_SOURCE } from "../config.js";
import logger from "../core/logger.js";

/**
 * Показывать ли кнопку «Побажання»: сбор идёт с 23-го и до тех пор, пока
 * владелец не закроет окно.
 *
 * Признак закрытия берётся из бэкенда — того же `preferencesClosedAt`, который
 * проверяет `assertWindowOpen` на записи, так что предложение и сохранение не
 * могут разойтись. Раньше он брался из ключа в Redis, который писала ТОЛЬКО
 * ветка синхронизации с Google Sheets; в проде `BUSINESS_DATA_SOURCE=aws`, где
 * `syncSchedule` выходит раньше записи ключа, — поэтому кнопка не исчезала
 * даже после публикации графика.
 *
 * При недоступном бэкенде кнопка ОСТАЁТСЯ: не показать её человеку, который
 * пришёл заполнить пожелания в срок, хуже, чем показать лишнюю после закрытия —
 * во втором случае он получит понятный отказ на сохранении, в первом просто не
 * найдёт, куда нажать.
 */
/**
 * Ответ на месяц один для всех и меняется раз в месяц, а меню рисуется на каждое
 * нажатие — и `shouldShowPreferencesButton` вызывается дважды за рендер (сам
 * пункт и fingerprint). Без кэша это два HTTP-запроса на каждое касание любой
 * кнопки в хабе. Минута выбрана так, чтобы закрытие сбора доходило до людей
 * практически сразу, но всплеск нажатий не превращался во всплеск запросов.
 */
const WINDOW_CACHE_TTL_MS = 60 * 1000;
let windowCache: { month: string; open: boolean; at: number } | undefined;

async function shouldShowPreferencesButton() {
    const now = new Date();
    const kyivNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
    if (kyivNow.getDate() < 23) return false;

    const nextMonth = new Date(kyivNow.getFullYear(), kyivNow.getMonth() + 1, 1);

    if (BUSINESS_DATA_SOURCE !== "aws") {
        const { systemStateRepository } = await import("../repositories/system-state-repository.js");
        const isPublished = await systemStateRepository.isSchedulePublishedForMonth(
            nextMonth.getFullYear(),
            nextMonth.getMonth() + 1
        );
        return !isPublished;
    }

    const month = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}`;
    if (windowCache && windowCache.month === month && Date.now() - windowCache.at < WINDOW_CACHE_TTL_MS) {
        return windowCache.open;
    }

    try {
        const { awsBusinessClient } = await import("../services/aws-business-client.js");
        const window = await awsBusinessClient.schedulePreferenceWindow(month);
        windowCache = { month, open: window.open, at: Date.now() };
        return window.open;
    } catch (error) {
        logger.warn({ err: error, month }, "Preference collection window unavailable; keeping the button");
        return true;
    }
}

// --- ROOT MENU ---
export const staffRootMenu = new Menu<MyContext>("staff-root");
menuRegistry.register(staffRootMenu);

// --- MAIN HUB MENU ---
// Stable fingerprint prevents false "outdated button" errors when only dynamic
// counters in labels change between render and callback handling.
export const staffHubMenu = new Menu<MyContext>("staff-main", {
    fingerprint: async (ctx) => {
        const now = new Date();
        const preferencesVisible = await shouldShowPreferencesButton() ? "pref" : "nopref";

        const telegramId = ctx.from?.id;
        if (!telegramId) return `staff-main:${preferencesVisible}:no-user`;

        const { userRepository } = await import("../repositories/user-repository.js");

        const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
        if (!user?.staffProfile) return `staff-main:${preferencesVisible}:no-staff`;

        const kyivToday = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
        kyivToday.setHours(0, 0, 0, 0);

        const hasShiftToday = (await getStaffShiftToday(user.staffProfile.id, kyivToday)) !== null;

        return `staff-main:${preferencesVisible}:${hasShiftToday ? "shift" : "no-shift"}`;
    }
});
menuRegistry.register(staffHubMenu);

staffHubMenu.dynamic(async (ctx, range) => {
    const now = new Date();
    const kyivNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));

    // 1. Побажання — ПЕРВЫМ, пока идёт сбор.
    //
    // Несколько дней в месяц это самое срочное, что есть у фотографа: у действия
    // дедлайн, и бот напоминает о нём каждые шесть часов. Всё остальное в хабе
    // доступно всегда. Раньше кнопка стояла третьей, ниже подмены, то есть
    // срочное пряталось за постоянным.
    //
    // Значок 📝, а не 🗓: «Мій графік» уже календарь, и два одинаковых значка
    // подряд заставляли читать подписи, чтобы понять разницу. Значок должен
    // различать, а не повторять.
    //
    // Собственная строка на всю ширину — подпись занимает 20–23 символа в
    // зависимости от месяца, и рядом с соседом обрезалась бы.
    if (await shouldShowPreferencesButton()) {
        const nextMonth = new Date(kyivNow.getFullYear(), kyivNow.getMonth() + 1, 1);
        const monthName = nextMonth.toLocaleString('uk-UA', { month: 'long' });
        range.text(`📝 Побажання (${monthName})`, async (ctx) => {
            // Trigger the callback handler by data or call the function directly
            // Since we want to break circular dependency, we can use ctx.menu.nav if it was a submenu,
            // but this is a separate flow. We can use a dynamic import here inside the handler.
            const { startPreferencesFlow } = await import("../handlers/preferences-flow.js");
            await startPreferencesFlow(ctx);
        }).row();
    }

    // 2. My Schedule
    range.text("🗓 Мій графік", async (ctx) => {
        const { showStaffSchedule } = await import("../modules/staff/handlers/menu.js");
        await showStaffSchedule(ctx);
    }).row();

    // Власний рядок: Telegram ділить ширину порівну і не переносить текст,
    // тож у парі з графіком ця назва обрізалась до «🔁 Пот...заміна».
    range.text("🔁 Шукати підміну", async (ctx) => {
        const { showReplacementShiftPicker } = await import("../modules/staff/handlers/menu.js");
        await showReplacementShiftPicker(ctx);
    }).row();

    // 3. Support / Care Service
    range.text("🤍 Служба турботи", async (ctx) => {
        const { startSupportFlow } = await import("../modules/staff/handlers/menu.js");
        await startSupportFlow(ctx);
    }).row();

    // 4. Tasks (Dynamic label with count from session)
    const count = ctx.session.activeTasksCount || 0;
    const taskLabel = count > 0 ? `📋 Мої завдання (${count})` : "📋 Мої завдання";

    range.text(taskLabel, async (ctx) => {
        const { showStaffTasks } = await import("../modules/staff/handlers/menu.js");
        await showStaffTasks(ctx);
    });

    // 5. Logistics (Parcels)
    const telegramId = ctx.from?.id;
    if (telegramId) {
        const { userRepository } = await import("../repositories/user-repository.js");
        const prisma = (await import("../db/core.js")).default;

        const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
        if (user && user.staffProfile) {
            const kyivToday = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
            kyivToday.setHours(0, 0, 0, 0);

            const todayShift = await getStaffShiftToday(user.staffProfile.id, kyivToday);
            if (todayShift) {
                const shift = todayShift;
                const pendingParcelsCount = await prisma.parcel.count({
                    where: {
                        locationId: shift.locationId,
                        OR: [
                            { status: { in: ['EXPECTED', 'ARRIVED'] } },
                            { status: 'DELIVERED', contentPhotoIds: { isEmpty: true } }
                        ]
                    }
                });

                const parcelLabel = pendingParcelsCount > 0 ? `📦 Посилки локації (${pendingParcelsCount})` : "📦 Посилки локації";
                range.row().text(parcelLabel, async (ctx) => {
                    const { showStaffLogistics } = await import("../modules/staff/handlers/menu.js");
                    await showStaffLogistics(ctx);
                });
            }
        }
    }
});

// --- SUBMENUS (Declared for type safety and navigation) ---
export const staffScheduleMenu = new Menu<MyContext>("staff-schedule");
menuRegistry.register(staffScheduleMenu);
export const staffTasksMenu = new Menu<MyContext>("staff-tasks");
menuRegistry.register(staffTasksMenu);
export const staffPreferencesMenu = new Menu<MyContext>("staff-preferences");
menuRegistry.register(staffPreferencesMenu);

// --- REGISTRATION ---
staffRootMenu.register(staffHubMenu);
staffHubMenu.register(staffScheduleMenu);
staffHubMenu.register(staffTasksMenu);
staffHubMenu.register(staffPreferencesMenu);
