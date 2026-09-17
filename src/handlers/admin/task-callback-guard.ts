import { Composer } from "grammy";
import type { MyContext } from "../../types/context.js";
import { requireRole } from "../../middleware/role-check.js";

/**
 * Роли, которым разрешены задачи и рассылки.
 *
 * Эта тройка уже стоит на вводе текста в task-flow.ts, task-bulk.ts, task-creation.ts,
 * broadcast.ts и steps.ts — гейт лишь распространяет ту же политику на кнопки.
 */
export const TASK_CALLBACK_ROLES = ['SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT'] as const;

/**
 * Префиксы колбэков задач и рассылок внутри adminHandlers.
 * `b_` — это b_test и b_send, то есть отправка рассылки на всю сеть.
 */
const GUARDED_PREFIXES = ["tbk_", "tas_", "task_", "b_"] as const;

/**
 * Колбэки, которые внешне похожи на задачи, но принадлежат стороне сотрудника
 * и живут вне adminHandlers (modules/staff/handlers/support.ts) со своей защитой.
 * Перехват здесь отобрал бы у сотрудников работу с подтверждениями.
 */
const EXEMPT_PREFIXES = ["task_proof_"] as const;

export function isGuardedTaskCallback(data: string): boolean {
    if (EXEMPT_PREFIXES.some(prefix => data.startsWith(prefix))) return false;
    return GUARDED_PREFIXES.some(prefix => data.startsWith(prefix));
}

/**
 * Гейт ролей для колбэков задач и рассылок.
 *
 * Монтировать ДО композеров задач: grammY выполняет middleware в порядке регистрации,
 * а обработчики задач завершают апдейт без next(), поэтому всё, что смонтировано
 * после них, для этих колбэков не выполняется вовсе. Именно поэтому запись префиксов
 * в protectedAdminCallbacks не работала — тот композер монтируется последним.
 */
export function buildTaskCallbackGuard(): Composer<MyContext> {
    const guard = new Composer<MyContext>();

    guard
        .filter(ctx => ctx.has("callback_query:data") && isGuardedTaskCallback(ctx.callbackQuery.data))
        .use(requireRole(...TASK_CALLBACK_ROLES));

    return guard;
}
