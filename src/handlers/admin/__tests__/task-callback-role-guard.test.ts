/**
 * Поведенческий тест гейта ролей на колбэках задач и рассылок.
 *
 * Репозиторий уже согласился, что задачи и рассылки — это SUPER_ADMIN | CO_FOUNDER | SUPPORT:
 * эта тройка стоит в task-flow.ts, task-bulk.ts, task-creation.ts, broadcast.ts и steps.ts.
 * Но стояла она только на ВВОДЕ ТЕКСТА. На кнопках проверки не было: HR_LEAD и MENTOR_LEAD
 * проходили весь мастер, удаляли задачи через task_del_exec_ и могли нажать b_send,
 * отправив рассылку всей сети.
 *
 * Прежний тест (task-bulk-wiring.test.ts) искал строку startsWith("tbk_") в исходнике
 * и зеленел, хотя requireRole для этого префикса не выполнялся вовсе: композеры задач
 * смонтированы раньше protectedAdminCallbacks и завершают апдейт без next().
 * Поэтому здесь мы гоняем НАСТОЯЩИЙ диспатч через Composer, а не грепаем текст.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "grammy";
import type { MyContext } from "../../../types/context.js";

const { getUserAdminRole } = vi.hoisted(() => ({
    getUserAdminRole: vi.fn(),
}));

vi.mock("../../../middleware/role-check.js", () => ({
    getUserAdminRole,
    requireRole: (...roles: string[]) => async (ctx: any, next: any) => {
        const role = await getUserAdminRole(BigInt(ctx.from?.id ?? 0));
        if (!role || !roles.includes(role)) {
            await ctx.answerCallbackQuery({ text: "denied", show_alert: true }).catch(() => { });
            return;
        }
        await next();
    },
}));

import { buildTaskCallbackGuard, TASK_CALLBACK_ROLES } from "../task-callback-guard.js";

function contextFor(data: string, telegramId = 777) {
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const ctx = {
        from: { id: telegramId },
        update: { update_id: 1, callback_query: { data } },
        callbackQuery: { data },
        answerCallbackQuery,
        has(filter: string) {
            return filter === "callback_query:data";
        },
    };
    return { ctx: ctx as unknown as MyContext, answerCallbackQuery };
}

/**
 * Собрать композер в том же порядке, что и боевой admin/index.ts: гейт впереди,
 * обработчик задачи за ним. Возвращает признак того, дошло ли дело до обработчика.
 */
async function dispatch(data: string, role: string | null) {
    getUserAdminRole.mockResolvedValue(role);

    const handlerRan = { value: false };
    const root = new Composer<MyContext>();

    root.use(buildTaskCallbackGuard());

    const flow = new Composer<MyContext>();
    flow.on("callback_query:data", async () => {
        handlerRan.value = true;
    });
    root.use(flow);

    const { ctx, answerCallbackQuery } = contextFor(data);
    await root.middleware()(ctx, async () => { });

    return { reached: handlerRan.value, answerCallbackQuery };
}

const TASK_CALLBACKS = [
    "tbk_d_2026-09-20",
    "tbk_send",
    "tas_city_Lviv",
    "task_del_exec_abc_2026-09-20",
    "b_send",
];

describe("task callback role guard", () => {
    beforeEach(() => {
        getUserAdminRole.mockReset();
    });

    it("pins the role set the repo already applies to task and broadcast text input", () => {
        expect(TASK_CALLBACK_ROLES).toEqual(['SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT']);
    });

    for (const role of TASK_CALLBACK_ROLES) {
        it(`lets ${role} through to the task handlers`, async () => {
            for (const data of TASK_CALLBACKS) {
                const { reached } = await dispatch(data, role);
                expect(reached, `${role} should reach ${data}`).toBe(true);
            }
        });
    }

    for (const role of ['HR_LEAD', 'MENTOR_LEAD']) {
        it(`blocks ${role} from every task and broadcast callback`, async () => {
            for (const data of TASK_CALLBACKS) {
                const { reached, answerCallbackQuery } = await dispatch(data, role);
                expect(reached, `${role} must not reach ${data}`).toBe(false);
                expect(answerCallbackQuery).toHaveBeenCalled();
            }
        });
    }

    it("blocks a user with no admin role at all", async () => {
        const { reached } = await dispatch("b_send", null);
        expect(reached).toBe(false);
    });

    it("leaves unrelated admin callbacks alone", async () => {
        for (const data of ["admin_main_menu", "view_staff_abc", "logi_parcel_1"]) {
            const { reached } = await dispatch(data, 'HR_LEAD');
            expect(reached, `${data} must pass through untouched`).toBe(true);
        }
    });

    it("does not capture the staff-side proof callback, which lives outside adminHandlers", async () => {
        // task_proof_close_* обрабатывается в modules/staff/handlers/support.ts со своей
        // защитой. Если бы гейт его перехватывал, сотрудник потерял бы доступ к пруфам.
        const { reached } = await dispatch("task_proof_close_abc123", 'HR_LEAD');
        expect(reached).toBe(true);
    });
});
