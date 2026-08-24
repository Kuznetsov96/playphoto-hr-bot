import { knownChatRepository } from "../repositories/known-chat-repository.js";

export type RevocationChat = { id: number; title: string | null; type: string };

/**
 * Область отзыва — все чаты, где бот сейчас состоит, а не собранный руками
 * список. Прежняя сборка `TEAM_CHATS` + `Location.telegramChatId` уже разошлась
 * с реальностью: у `Lviv / Dragon Park 2` не заполнен `telegramChatId`, поэтому
 * чат был невидим для отзыва и уволенный фотограф сохранял в нём доступ. Реестр
 * знает про чат независимо от того, завели ли ему строку в справочнике локаций.
 *
 * Идентификаторы в реестре `bigint`, а на границе Telegram API — `number`,
 * поэтому сужаются здесь один раз, вместе с отсевом нулевых и NaN.
 *
 * Тип чата едет вместе с id: от него зависит, нужна ли проверка присутствия
 * перед баном. Разделять по конкретному id нельзя — второй канал появится и
 * правило молча его не покроет.
 *
 * Живёт отдельным модулем, потому что читателей два — `AccessService` (отзыв по
 * строке очереди с повтором) и `ScheduleSyncService` (пакетная сверка без
 * очереди). Пока сборка области была скопирована в оба, правка одного читателя
 * не доезжала до второго: так и случилось с баном в канале, где `left` ошибочно
 * пропускался.
 */
export async function getRevocationChats(): Promise<RevocationChat[]> {
    const chats = await knownChatRepository.listActive();
    const seen = new Set<number>();
    const result: RevocationChat[] = [];
    for (const chat of chats) {
        const id = Number(chat.id);
        if (!id || Number.isNaN(id) || seen.has(id)) continue;
        seen.add(id);
        result.push({ id, title: chat.title, type: chat.type });
    }
    return result;
}

/**
 * Ответы Telegram на бан того, кого в чате нет и не было. Ни один из них не
 * означает «боту отказано»: настоящий отказ отвечает `CHAT_ADMIN_REQUIRED`,
 * `not enough rights`, `chat not found` либо вовсе не доезжает (сетевая
 * ошибка), и ни в одном таком описании этих подстрок не встречается — проверено
 * по списку описаний Bot API. Поэтому терпеть их безопасно: цель «вход закрыт»
 * достигнута и без бана, а провал строки заставил бы диспетчер повторять бан,
 * которому нечего банить.
 *
 * Совпадение намеренно узкое — подстрока в тексте описания, — чтобы новый вид
 * отказа не начал молча считаться успехом.
 */
const ABSENT_MEMBER_ERRORS = [
    "user not found",
    "member not found",
    "participant_id_invalid",
    "user not participant",
];

export function isAbsentMemberError(description: string | null | undefined): boolean {
    const text = String(description || "").toLowerCase();
    return ABSENT_MEMBER_ERRORS.some(marker => text.includes(marker));
}
