/**
 * Строгий формат HH:MM для дедлайнів завдань.
 *
 * `/^\d{1,2}:\d{2}$/`, який раніше жив у task-creation.ts і task-flow.ts,
 * приймав "99:99" і "5:77" як валідний час — тут же обмежені і години
 * (00-23), і хвилини (00-59).
 */
const TASK_DEADLINE_TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

export function isValidTaskDeadlineTime(input: string): boolean {
    return TASK_DEADLINE_TIME_RE.test(input);
}
