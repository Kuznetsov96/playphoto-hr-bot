import { escapeHtml } from "../handlers/admin/utils.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";

export type AnsweredOfferOutcome = "accepted" | "declined" | "gone";

/**
 * Детали смены, вытащенные из текста самого сообщения.
 *
 * Именно из текста, а не из ответа бэкенда, и это не экономия запроса: бэкенд
 * отдаёт `shiftStartsAt` в UTC, и смена, которая начинается о 14:00 за Києвом,
 * показалась б фотографині як 11:00. Текст оффера уже содержит правильное
 * местное время — оно было посчитано один раз при отправке и с тех пор верно.
 */
type OfferDetails = { location: string; date: string; time: string };

/** Строки-маркеры, которыми `renderCandidateMessage` собирает карточку оффера. */
const LOCATION_MARK = "📍";
const DATE_MARK = "📅";
const TIME_MARK = "🕐";

function readMarkedLine(text: string, mark: string): string {
    const line = text.split("\n").find((candidate) => candidate.trimStart().startsWith(mark));
    return line === undefined ? "" : line.trimStart().slice(mark.length).trim();
}

/**
 * Разбор опирается на маркеры, а не на номера строк: у карточки два варианта
 * вступления — нейтральный и для той, кто отметила день занятым, — и они разной
 * высоты. Привязка к номеру строки сломалась бы на втором.
 *
 * Текст приходит уже экранированным (сообщение ушло с parse_mode: HTML), но
 * прогоняется через `escapeHtml` ещё раз: если разбор промахнётся и захватит
 * что-то другое, лучше показать безобидную строку, чем дать Telegram отклонить
 * правку и оставить кнопки живыми.
 */
function readOfferDetails(text: string): OfferDetails | null {
    const location = readMarkedLine(text, LOCATION_MARK);
    const date = readMarkedLine(text, DATE_MARK);
    if (location === "" || date === "") return null;
    return { location: escapeHtml(location), date: escapeHtml(date), time: escapeHtml(readMarkedLine(text, TIME_MARK)) };
}

/**
 * Текст, которым сообщение оффера заменяется после ответа кандидатки.
 *
 * Переписывание, а не новое сообщение: исход должен читаться там же, где
 * названа смена. Отдельное сообщение оторвало бы «Зміна твоя» от того, о чём
 * оно, а при девятнадцяти оферах на один пошук ще й засмітило б стрічку.
 */
export function buildAnsweredOfferText(originalText: string, outcome: AnsweredOfferOutcome): string {
    const details = readOfferDetails(originalText);
    if (details === null) {
        // Разбор не удался — деталей не будет, но сообщение обязано перестать
        // выглядеть действующим. Исход без подробностей лучше живой на вид кнопки.
        return STAFF_TEXTS[`staff-replacement-offer-answered-${outcome}-bare`];
    }
    return STAFF_TEXTS[`staff-replacement-offer-answered-${outcome}`](details);
}
