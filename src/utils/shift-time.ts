export function getShiftTimeFromLocationSchedule(schedule: string | null | undefined, shiftDate: Date): string | undefined {
    if (!schedule) return undefined;

    const isWeekend = [0, 6].includes(shiftDate.getDay());
    const match = isWeekend
        ? schedule.match(/Сб-Нд\s*[—-]\s*(\d{2}:\d{2}[—-]\d{2}:\d{2})/i)
        : schedule.match(/Пн-Пт\s*[—-]\s*(\d{2}:\d{2}[—-]\d{2}:\d{2})/i);

    return match?.[1];
}
