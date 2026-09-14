export type BackfillResult = {
    scanned: number;
    filled: number;
    unmatched: number;
};

export type BackfillDb = {
    replacementRequest: {
        findMany: (args: unknown) => Promise<Array<{ id: string; workShiftId: string | null }>>;
        update: (args: unknown) => Promise<unknown>;
    };
    workShift: {
        findMany: (args: unknown) => Promise<Array<{ id: string; awsScheduledShiftPublicId: string | null }>>;
    };
};

/**
 * Заповнює `scheduledShiftPublicId` для заявок на заміну, створених до того,
 * як цей канонічний id почав записуватись одразу.
 *
 * Пара береться з дзеркала: `WorkShift.awsScheduledShiftPublicId` — той самий
 * канонічний ідентифікатор, який синк проставляє кожному рядку зміни.
 *
 * Заявки без пари не мовчать: вони рахуються в `unmatched`, і викликач має
 * показати це число. Мовчазний частковий бекфіл лишив би заявку прив'язаною
 * лише до локального рядка, і ніхто б про це не дізнався — саме цього і
 * уникає весь проєкт канонічного зв'язування.
 */
export async function backfillReplacementScheduledShiftIds(db: BackfillDb): Promise<BackfillResult> {
    const requests = await db.replacementRequest.findMany({
        where: { scheduledShiftPublicId: null, workShiftId: { not: null } },
        select: { id: true, workShiftId: true },
    });

    if (requests.length === 0) return { scanned: 0, filled: 0, unmatched: 0 };

    const shiftIds = [...new Set(requests.flatMap(row => (row.workShiftId ? [row.workShiftId] : [])))];
    const shifts = await db.workShift.findMany({
        where: { id: { in: shiftIds } },
        select: { id: true, awsScheduledShiftPublicId: true },
    });
    const canonicalByShiftId = new Map(shifts.map(shift => [shift.id, shift.awsScheduledShiftPublicId]));

    let filled = 0;
    for (const request of requests) {
        const canonical = request.workShiftId ? canonicalByShiftId.get(request.workShiftId) : null;
        if (!canonical) continue;
        await db.replacementRequest.update({
            where: { id: request.id },
            data: { scheduledShiftPublicId: canonical },
        });
        filled += 1;
    }

    return { scanned: requests.length, filled, unmatched: requests.length - filled };
}
