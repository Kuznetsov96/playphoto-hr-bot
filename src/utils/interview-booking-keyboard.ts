import { InlineKeyboard } from "grammy";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { buildSignedCallback } from "./signed-callback.js";
import { hasInterviewStarted } from "./screening-state.js";

/**
 * Кнопки записаної на співбесіду — одні для підтвердження броні й екрана
 * статусу. Два місця малювали їх окремо, і правило «після початку не
 * переносити» довелося б тримати двічі.
 *
 * До початку: змінити час, скасувати, відмовитись. Після: лише «Я на
 * зв'язку, HR ще немає» — сигнал рекрутерці, а не рух воронки.
 */
export function buildBookedInterviewKeyboard(
    slotId: string,
    startTime: Date | string | null | undefined,
    options: { canContactStaff: boolean; now?: Date },
): InlineKeyboard {
    const kb = new InlineKeyboard();
    if (hasInterviewStarted(startTime, options.now)) {
        kb.text(CANDIDATE_TEXTS["candidate-btn-waiting-for-hr"], buildSignedCallback("hw", slotId)).row();
    } else {
        kb.text(CANDIDATE_TEXTS["candidate-btn-reschedule"], buildSignedCallback("rb", slotId)).row()
            .text("Скасувати запис", buildSignedCallback("cb", slotId)).danger().row()
            .text("Не планую продовжувати", buildSignedCallback("wi", slotId)).danger().row();
    }
    if (options.canContactStaff) kb.text("Написати нам", "contact_hr");
    return kb;
}
