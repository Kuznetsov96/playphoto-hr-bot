import { MAX_VOLKLAND_2_ZP_CANDIDATE_AGE, MIN_VOLKLAND_2_ZP_CANDIDATE_AGE } from "./candidate-age.js";

/**
 * Вибір дати народження кнопками замість тексту.
 *
 * Ручний ввід у форматі ДД.ММ.РРРР приречений на опечатки: бот не керує
 * клавіатурою клієнта, тож людина набирає десять символів на буквенній
 * розкладці. Три екрани кнопок — рік, місяць, день — знімають і опечатки, і
 * три гілки помилок, і глухий кут без кнопки «Назад».
 *
 * Чому саме повна дата, а не лише рік. Точний день потрібен двом живим
 * механізмам: birthday-service вітає кандидаток за збігом дня й місяця
 * (candidate-repository.findBirthdaysToday), а underage-reactivation-service
 * розблоковує анкету рівно на 16-річчя (getBirthDateRejection). Якби ми
 * зберігали лише рік, дата лягла б на 1 січня: масова розсилка привітань
 * щосічня і розблокування «грудневих» анкет на дев'ять місяців раніше.
 */

/** Скільки років показувати у списку. */
export function getSelectableBirthYears(today: Date = new Date()): number[] {
    const currentYear = today.getFullYear();
    // Верхня межа списку — наймолодший вік, з яким узагалі беруть (16 на
    // Volkland 2), нижня — найстарший (28). Список навмисно ширший за межі
    // конкретної локації: вона ще невідома, локацію обирають пізніше, а
    // відмову за віком видає getAgeRejection уже зі знанням локації.
    const youngestYear = currentYear - MIN_VOLKLAND_2_ZP_CANDIDATE_AGE;
    const oldestYear = currentYear - MAX_VOLKLAND_2_ZP_CANDIDATE_AGE - 1;

    const years: number[] = [];
    for (let year = youngestYear; year >= oldestYear; year--) {
        years.push(year);
    }
    return years;
}

/**
 * Межі повного вибору року — для тих, кого немає у скороченому списку.
 *
 * Короткий список покриває лише вік, з яким беруть у команду, і людина поза
 * ним не могла вказати свій рік узагалі: кнопки просто не існувало. Тепер
 * за кнопкою «Інший рік» відкривається повний діапазон.
 *
 * Це не робить нікого прийнятним — вік перевіряється далі, як і раніше. Але
 * молодшій за 16 це дає єдиний шлях лишити анкету: underage-reactivation
 * розблокує її в день 16-річчя, а без збереженої дати цього не станеться.
 */
export const MIN_BIRTH_YEAR_AGE = 14;
export const MAX_BIRTH_YEAR_AGE = 60;

/** Десятиріччя для першого екрана повного вибору: [2010, 2000, 1990…]. */
export function getSelectableBirthDecades(today: Date = new Date()): number[] {
    const currentYear = today.getFullYear();
    const newest = Math.floor((currentYear - MIN_BIRTH_YEAR_AGE) / 10) * 10;
    const oldest = Math.floor((currentYear - MAX_BIRTH_YEAR_AGE) / 10) * 10;

    const decades: number[] = [];
    for (let d = newest; d >= oldest; d -= 10) {
        decades.push(d);
    }
    return decades;
}

/** Роки всередині десятиріччя, обрізані по загальних межах. */
export function getYearsInDecade(decade: number, today: Date = new Date()): number[] {
    const currentYear = today.getFullYear();
    const newestAllowed = currentYear - MIN_BIRTH_YEAR_AGE;
    const oldestAllowed = currentYear - MAX_BIRTH_YEAR_AGE;

    const years: number[] = [];
    for (let year = Math.min(decade + 9, newestAllowed); year >= Math.max(decade, oldestAllowed); year--) {
        years.push(year);
    }
    return years;
}

export const BIRTH_MONTH_LABELS = [
    "Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень",
    "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень",
] as const;

/** Кількість днів у місяці з урахуванням високосного року. */
export function getDaysInMonth(year: number, month: number): number {
    // month — 1..12; day 0 наступного місяця — останній день поточного.
    return new Date(year, month, 0).getDate();
}

/**
 * Збирає дату з обраних частин. Повертає null, якщо частини неповні або
 * складаються в неіснуючу дату (31 лютого через зміну місяця після дня).
 */
export function buildBirthDate(year?: number, month?: number, day?: number): Date | null {
    if (!year || !month || !day) return null;
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > getDaysInMonth(year, month)) return null;

    // UTC: findBirthdaysToday звіряє getUTCDate/getUTCMonth, тож дата має
    // лягти в опівніч UTC, інакше в мінусовому зсуві день «поїде» назад.
    return new Date(Date.UTC(year, month - 1, day));
}
