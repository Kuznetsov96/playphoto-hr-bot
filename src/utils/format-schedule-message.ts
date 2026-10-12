import { escapeHtml } from "../handlers/admin/utils.js";

/** Індексується значенням `Date.getUTCDay()`: 0 — неділя. */
const WEEKDAY_SHORT_UK = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"] as const;

/** «Графік на вересень» — знахідний відмінок збігається з називним. */
const MONTHS_UK_NOMINATIVE = [
    "січень",
    "лютий",
    "березень",
    "квітень",
    "травень",
    "червень",
    "липень",
    "серпень",
    "вересень",
    "жовтень",
    "листопад",
    "грудень",
] as const;

/** До скількох змін показується повний список — довше не вміщується на екран телефона. */
const FULL_LIST_LIMIT = 15;

/** Скільки рядків лишається, коли список не вміщується цілком. */
const LIST_HEAD = 10;

/** «Тепер у тебе в жовтні …» — місцевий відмінок. */
const MONTHS_UK_LOCATIVE = [
    "січні",
    "лютому",
    "березні",
    "квітні",
    "травні",
    "червні",
    "липні",
    "серпні",
    "вересні",
    "жовтні",
    "листопаді",
    "грудні",
] as const;

export type ScheduleMessageShift = {
    /** `YYYY-MM-DD` — локальна дата зміни. */
    localDate: string;
    locationLabel: string;
    startsAtLocal: string;
    endsAtLocal: string;
};

/** `2026-09-05` -> 6 (субота). Дата читається як текст, без таймзони. */
function weekdayOf(localDate: string): number {
    return new Date(`${localDate}T12:00:00.000Z`).getUTCDay();
}

function isWeekend(localDate: string): boolean {
    const day = weekdayOf(localDate);
    return day === 0 || day === 6;
}

/** `2026-09-05` -> «вересень». Порожньо, якщо дата не читається. */
export function monthNameOf(localDate: string): string {
    const month = Number(localDate.slice(5, 7));
    return MONTHS_UK_NOMINATIVE[month - 1] ?? "";
}

/**
 * Один рядок зміни: `сб 12.09 · Dragon Park (Lviv) · 10:00–20:00`.
 *
 * Єдиний формат для публікації місяця і для сповіщень про зміни: людина
 * читає дату однаково скрізь, і день тижня завжди поруч — вихідний видно,
 * а не рахується. Вихідні виділені. Роздільник, а не колонки з пробілів:
 * у Telegram шрифт пропорційний, і «вирівняні» пробілами стовпці
 * розповзаються на кожному рядку. Підпис локації екранується — результат
 * іде в Telegram як HTML.
 */
export function formatShiftLine(shift: ScheduleMessageShift, options: { withLocation?: boolean } = {}): string {
    const day = dayLabel(shift.localDate);
    const time = timeLabel(shift);
    const location = options.withLocation === false ? "" : escapeHtml(shift.locationLabel);
    return [day, location, time].filter((part) => part.length > 0).join(" · ");
}


/** `2026-10-03` -> `<b>сб 03.10</b>`; вихідні виділені. */
function dayLabel(localDate: string): string {
    const weekday = WEEKDAY_SHORT_UK[weekdayOf(localDate)];
    const dayMonth = `${localDate.slice(8)}.${localDate.slice(5, 7)}`;
    return isWeekend(localDate) ? `<b>${weekday} ${dayMonth}</b>` : `${weekday} ${dayMonth}`;
}

function timeLabel(shift: ScheduleMessageShift): string {
    return shift.startsAtLocal && shift.endsAtLocal ? `${shift.startsAtLocal}–${shift.endsAtLocal}` : shift.startsAtLocal;
}

/** `2026-10-12` -> «жовтні». Порожньо, якщо дата не читається. */
export function monthLocativeOf(localDate: string): string {
    const month = Number(localDate.slice(5, 7));
    return MONTHS_UK_LOCATIVE[month - 1] ?? "";
}

/** 1 зміна · 3 зміни · 5 змін · 11 змін · 21 зміна. */
export function shiftsWord(count: number): string {
    const tens = count % 100;
    const ones = count % 10;
    if (ones === 1 && tens !== 11) return "зміна";
    if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return "зміни";
    return "змін";
}

/**
 * «Тепер у тебе в жовтні 4 зміни.» — підсумок місяця під повідомленням про
 * окрему подію (термінова зміна, підміна). Без нього людина не знає, чи
 * лишилося в неї щось у цьому місяці, і звіряє з попередніми повідомленнями.
 */
export function formatMonthTotal(localDate: string, count: number): string {
    const month = monthLocativeOf(localDate);
    if (count === 0) return `У ${month} змін у тебе більше немає.`;
    return `Тепер у тебе в ${month} <b>${count}</b> ${shiftsWord(count)}.`;
}

/** Позначка рядка в списку місяця: що саме в ньому нове. */
export type MonthRowMark = "added" | "moved" | "changed";

export type MonthRow = {
    shift: ScheduleMessageShift;
    /** Однаковий для однієї локації; за ним локація виноситься в шапку. */
    locationKey: string;
    mark?: MonthRowMark;
};

/**
 * Те, чого в списку місяця вже немає, але людина мусить про це дізнатися:
 * знята зміна, попередній вигляд зміненої, віддана через підміну.
 */
export type MonthNote = {
    kind: "removed" | "movedFrom" | "given";
    shift: ScheduleMessageShift;
    locationKey: string;
    /** Для `movedFrom`: якою зміна стала — з цього видно, що саме змінилося. */
    to?: ScheduleMessageShift;
};

/**
 * Позначка — словом у кінці рядка, а не значком попереду: значок зсував дату
 * лише в позначених рядках, і стовпчик дат «скакав» (власник, 12.10.2026).
 * Слово зрозуміле без легенди.
 */
const MARK_WORD: Record<MonthRowMark, string> = { added: "нова", moved: "перенесена", changed: "змінена" };

/**
 * Рядок над списком — повним реченням без значків: «🔄 Було: чт 22.10» не
 * казало, що саме було і куди воно ділося (власник, 12.10.2026). Для зміненої
 * зміни називається саме те, що змінилося, а новий вигляд — у списку нижче.
 */
function formatNote(note: MonthNote, line: (shift: ScheduleMessageShift) => string): string {
    if (note.kind === "removed") return `Знято: ${line(note.shift)}`;
    if (note.kind === "given") return `Підміну знайдено: ${line(note.shift)}`;
    const to = note.to;
    if (to === undefined) return `Знято: ${line(note.shift)}`;
    if (to.localDate !== note.shift.localDate) {
        return `Перенесено: ${dayLabel(note.shift.localDate)} → ${dayLabel(to.localDate)}`;
    }
    if (timeLabel(to) !== timeLabel(note.shift)) {
        return `Змінено час: ${dayLabel(to.localDate)}, було ${timeLabel(note.shift)}`;
    }
    return `Змінено точку: ${dayLabel(to.localDate)}, було ${escapeHtml(note.shift.locationLabel)}`;
}

/**
 * Повідомлення про графік одного місяця — завжди з УСІМ місяцем людини.
 *
 * Інцидент 12.10.2026: фотографка отримала «Графік на жовтень готовий» двічі
 * (3 зміни, потім ще 2 дописані) і вирішила, що останнє повідомлення — це
 * весь її місяць. Читати останнє повідомлення як повний графік — природно,
 * тому тепер так і є: кожне повідомлення показує весь місяць на зараз, а нове
 * в ньому позначене. Заголовок розрізняє першу публікацію («готовий») і
 * зміну вже опублікованого («змінено»), а число завжди означає робочі дні
 * людини, ніколи — кількість подій («Всього змін: 19» при 14 знятих і 5
 * доданих).
 *
 * Локація, спільна для всіх рядків, виноситься в шапку: рядок зміни вміщується
 * в один рядок екрана телефона, і місяць видно без прокрутки. Список обрізається
 * за числом РЯДКІВ (не символів — обрубок дати гірший за чесне «та ще N»), і в
 * зміненому місяці показуються саме позначені рядки.
 */
export function formatMonthSection(input: {
    mode: "published" | "updated";
    /** Будь-яка дата цього місяця — з неї беруться назви місяця. */
    monthDate: string;
    rows: MonthRow[];
    notes: MonthNote[];
}): string {
    // У першій публікації нове все, тож позначки там лише шум.
    const rows = input.rows
        .map((row) => (input.mode === "published" ? { ...row, mark: undefined } : row))
        .sort((left, right) => compareShifts(left.shift, right.shift));
    const notes = [...input.notes].sort((left, right) => compareShifts(left.shift, right.shift));
    const locationKeys = new Set([...rows, ...notes].map((item) => item.locationKey));
    const sharedLabel = locationKeys.size === 1 ? (rows[0] ?? notes[0])?.shift.locationLabel : undefined;
    const withLocation = sharedLabel === undefined;
    const line = (shift: ScheduleMessageShift) => formatShiftLine(shift, { withLocation });

    const blocks: string[] = [
        input.mode === "published"
            ? `✅ <b>Графік на ${monthNameOf(input.monthDate)} готовий</b>`
            : `🗓 <b>Графік на ${monthNameOf(input.monthDate)} змінено</b>`,
    ];

    if (notes.length > 0) {
        blocks.push(notes.map((note) => formatNote(note, line)).join("\n"));
    }

    const total = rows.length;
    if (total === 0) {
        blocks.push(`У ${monthLocativeOf(input.monthDate)} змін у тебе більше немає.`);
        return blocks.join("\n\n");
    }

    const weekends = rows.filter((row) => isWeekend(row.shift.localDate)).length;
    const count = `<b>${total}</b> ${shiftsWord(total)}`;
    const summary = [
        `${input.mode === "published" ? "У тебе" : "Тепер у тебе"} ${count}${weekends > 0 ? ` · у вихідні: <b>${weekends}</b>` : ""}`,
    ];
    if (sharedLabel !== undefined) summary.push(`📍 ${escapeHtml(sharedLabel)}`);
    blocks.push(summary.join("\n"));

    const marked = rows.filter((row) => row.mark !== undefined);
    const shown =
        total <= FULL_LIST_LIMIT
            ? rows
            : input.mode === "updated" && marked.length > 0
            ? marked.slice(0, LIST_HEAD)
            : rows.slice(0, LIST_HEAD);
    const list = shown.map((row) => (row.mark ? `${line(row.shift)} · ${MARK_WORD[row.mark]}` : line(row.shift)));
    if (shown.length < total) list.push(`та ще ${total - shown.length} — у «Мій графік»`);
    blocks.push(list.join("\n"));

    if (input.mode === "published") {
        blocks.push("Якщо якийсь день не підійде — відкрий «Мій графік» і попроси підміну.");
    }

    return blocks.join("\n\n");
}

function compareShifts(left: ScheduleMessageShift, right: ScheduleMessageShift): number {
    return left.localDate.localeCompare(right.localDate) || left.startsAtLocal.localeCompare(right.startsAtLocal);
}

/**
 * Нові зміни, коли весь місяць прочитати не вдалося. Без «готовий» і без
 * числа: ні те, ні інше не можна сказати, не знаючи решти місяця, а саме вони
 * читалися як «це весь мій графік».
 */
export function formatNewShiftsList(shifts: ScheduleMessageShift[]): string {
    const ordered = [...shifts].sort(compareShifts);
    const months = new Set(ordered.map((shift) => shift.localDate.slice(0, 7)));
    const title =
        months.size === 1 && ordered[0] !== undefined
            ? `🗓 <b>Нові зміни на ${monthNameOf(ordered[0].localDate)}</b>`
            : "🗓 <b>Нові зміни у графіку</b>";
    const shown = ordered.length <= FULL_LIST_LIMIT ? ordered : ordered.slice(0, LIST_HEAD);
    const list = shown.map((shift) => formatShiftLine(shift));
    if (shown.length < ordered.length) list.push(`та ще ${ordered.length - shown.length}`);
    return `${title}\n\n${list.join("\n")}\n\nПовний графік — у «Мій графік».`;
}
