/**
 * Скільки змін показати на екрані вибору. Двадцять однорядкових кнопок
 * телефон гортає без зусиль, а клавіатура Telegram вміщає їх із запасом.
 *
 * Це не сторінка, а стеля: у проді найдовший графік попереду — 13 змін, тож
 * у звичайний день зріз не спрацьовує взагалі й людина бачить усе. Стеля існує
 * рівно для аномалії (графік на пів року вперед), щоб екран не перетворився на
 * полотно з сотні кнопок.
 */
export const SHIFT_PICKER_VISIBLE_LIMIT = 20;

export type ShiftPickerView<T> = {
    visible: T[];
    hiddenCount: number;
    text: string;
};

/**
 * Вирішує, що показати і що сказати.
 *
 * Головне тут — друге. Старий екран мовчки різав список до восьми, і зникнення
 * зміни виглядало для фотографині як «її просто немає»: ані рядка про те, що
 * список неповний. Тому, коли зріз усе ж спрацював, він мусить назвати себе —
 * рівно як це давно робить адмінська дошка замін.
 */
export function buildShiftPickerView<T>(shifts: T[]): ShiftPickerView<T> {
    const visible = shifts.slice(0, SHIFT_PICKER_VISIBLE_LIMIT);
    const hiddenCount = shifts.length - visible.length;

    if (hiddenCount === 0) {
        return { visible, hiddenCount, text: "Обери дату і локацію." };
    }

    return {
        visible,
        hiddenCount,
        text:
            `Обери дату і локацію.\n\n` +
            `Показані найближчі ${visible.length} змін з ${shifts.length}. ` +
            `Решта з'явиться тут, щойно ці пройдуть.`
    };
}
