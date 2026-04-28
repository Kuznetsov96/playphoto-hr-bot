import prisma from "../db/core.js";

function formatMonthKey(year: number, month: number): string {
    return `${year}-${String(month).padStart(2, "0")}`;
}

export class SystemStateRepository {
    async get(key: string): Promise<string | null> {
        const record = await prisma.systemState.findUnique({ where: { key } });
        return record?.value ?? null;
    }

    async set(key: string, value: string): Promise<void> {
        await prisma.systemState.upsert({
            where: { key },
            update: { value },
            create: { key, value }
        });
    }

    async getJson<T>(key: string): Promise<T | null> {
        const value = await this.get(key);
        if (!value) return null;
        try {
            return JSON.parse(value) as T;
        } catch {
            return null;
        }
    }

    async setJson(key: string, value: unknown): Promise<void> {
        await this.set(key, JSON.stringify(value));
    }

    async isSchedulePublishedForMonth(year: number, month: number): Promise<boolean> {
        const value = await this.get(`schedule-published:${formatMonthKey(year, month)}`);
        return value === "1";
    }

    async markSchedulePublishedForMonth(year: number, month: number): Promise<void> {
        await this.set(`schedule-published:${formatMonthKey(year, month)}`, "1");
    }
}

export const systemStateRepository = new SystemStateRepository();
