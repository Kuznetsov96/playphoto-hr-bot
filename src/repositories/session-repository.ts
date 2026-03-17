import prisma from "../db/core.js";

export class SessionRepository {
    async findByKey(key: string) {
        return (prisma as any).session.findUnique({
            where: { key }
        });
    }

    async update(key: string, value: string) {
        return (prisma as any).session.update({
            where: { key },
            data: { value }
        });
    }

    async upsert(key: string, value: string) {
        return (prisma as any).session.upsert({
            where: { key },
            update: { value },
            create: { key, value }
        });
    }
}

export const sessionRepository = new SessionRepository();
