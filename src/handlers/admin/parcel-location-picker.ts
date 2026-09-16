import { formatLogisticsLocation } from "../../utils/logistics-formatters.js";

/**
 * Подписи и порядок кнопок на экране «Set Location».
 *
 * Вынесено из обработчика отдельной функцией, потому что проверять надо именно список
 * целиком: свойство «ни одна кнопка не повторяет другую» не видно на одной локации, а
 * ломается оно на всём справочнике сразу. Раньше кнопка показывала сырое `location.name`,
 * и на экране стояли три неразличимых Karamel, четыре Smile Park и три Volkland.
 *
 * Подпись берётся у канонического форматтера в контексте "listing": пикер не ограничен
 * одним городом, и город — половина ответа на вопрос «какой из трёх Volkland этот».
 * Филиал добавляет сам форматтер там, где он заведён в справочнике.
 */

export type PickerLocation = {
    id: string;
    name?: string | null;
    city?: string | null;
    branch?: string | null;
};

export type ParcelLocationChoice = {
    id: string;
    label: string;
};

export function buildParcelLocationChoices(
    locations: readonly PickerLocation[]
): ParcelLocationChoice[] {
    return locations
        .map((location) => ({
            id: location.id,
            label: formatLogisticsLocation(location),
            // Сортируем по городу отдельным ключом, а не по готовой подписи: в подписи город
            // стоит в конце, и сортировка по ней разбросала бы три Volkland по всему списку.
            city: location.city?.trim() ?? "",
        }))
        .sort((left, right) => {
            const byCity = left.city.localeCompare(right.city, "uk");
            return byCity !== 0 ? byCity : left.label.localeCompare(right.label, "uk");
        })
        .map(({ id, label }) => ({ id, label }));
}
