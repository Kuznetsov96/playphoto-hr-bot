import { InlineKeyboard } from "grammy";
import { formatKyivWeekdayDateTime } from "./kyiv-date-label.js";

/**
 * Клавіатура вибору часу співбесіди/навчання. Винесена з handlers/booking.ts,
 * бо той самий список слотів надсилає й команда вебаппа «перенести
 * співбесіду» (рішення власника 01.10.2026): дві копії клавіатури рано чи
 * пізно розійшлися б у підписах і ліміті.
 */


export type SlotButton = {
    id: string;
    startTime: Date;
};

/**
 * Підпис кнопки слота: «пт 12.09 · 14:00».
 *
 * День тижня — не прикраса. Раніше кнопка казала «12.09 14:00», і щоб
 * зрозуміти, чи це робочий день, людині доводилося йти в календар. Місяць
 * лишається: за два тижні наперед «12» без місяця вже неоднозначне.
 *
 * Скорочення дня тижня в uk-UA виходить як «пт», без крапки. Підпис росте
 * до ~16 символів — саме тому кнопки стоять по одній у рядок.
 */
function formatSlotButton(slot: SlotButton) {
    return formatKyivWeekdayDateTime(slot.startTime, " · ");
}

/**
 * Ліміт слотів на екрані. Був 40: у два стовпці це двадцять рядів, а в один
 * стовпець стало б сорок — стіна, яку неможливо охопити оком, і кнопка «Не
 * бачу зручного часу» під нею недосяжна без довгого скролу. Дванадцять
 * найближчих слотів покривають вибір на кілька днів уперед; кому не
 * підходить жоден, тому потрібна не довша сторінка, а інші дати.
 */
export const SLOT_KEYBOARD_LIMIT = 12;
export const NO_TIME_FITS_LABEL = "Не бачу зручного часу";

export function buildSlotSelectionKeyboard(
    slots: SlotButton[],
    bookCallbackPrefix: string,
    noFitCallback: string,
    limit = SLOT_KEYBOARD_LIMIT,
    noFitLabel = NO_TIME_FITS_LABEL
) {
    const keyboard = new InlineKeyboard();

    // Один слот у рядок. З днем тижня підпис виріс до ~16 символів, а
    // Telegram ділить ширину рядка порівну: дві такі кнопки поруч на
    // вузькому екрані обрізаються рівно там, де стоїть час. Вертикальний
    // список читається як розклад і не змушує звіряти дати по діагоналі.
    slots.slice(0, limit).forEach((slot) => {
        keyboard.text(formatSlotButton(slot), `${bookCallbackPrefix}${slot.id}`).row();
    });

    keyboard.text(noFitLabel, noFitCallback).row();
    return keyboard;
}
