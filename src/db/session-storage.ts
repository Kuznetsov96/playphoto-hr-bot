import type { StorageAdapter } from "grammy";
import prisma from "./core.js";

export class PrismaAdapter<T> implements StorageAdapter<T> {
    async read(key: string): Promise<T | undefined> {
        const start = Date.now();
        console.log(`🗄️ [SESSION] Reading key: ${key}...`);
        try {
            const session = await (prisma as any).session.findUnique({
                where: { key },
            });
            console.log(`🗄️ [SESSION] Read key ${key} in ${Date.now() - start}ms`);
            if (!session) return undefined;
            return JSON.parse(session.value) as T;
        } catch (e) {
            console.error(`❌ [SESSION] FAILED to read key ${key}:`, e);
            return undefined;
        }
    }

    async write(key: string, value: T): Promise<void> {
        const start = Date.now();
        console.log(`🗄️ [SESSION] Writing key: ${key}...`);
        try {
            const data = JSON.stringify(value);
            await (prisma as any).session.upsert({
                where: { key },
                update: { value: data },
                create: { key, value: data },
            });
            console.log(`🗄️ [SESSION] Wrote key ${key} in ${Date.now() - start}ms`);
        } catch (e) {
            console.error(`❌ [SESSION] FAILED to write key ${key}:`, e);
        }
    }

    async delete(key: string): Promise<void> {
        console.log(`🗄️ [SESSION] Deleting key: ${key}...`);
        await (prisma as any).session.delete({
            where: { key },
        }).catch(() => { }); // Ignore if already deleted
    }
}
