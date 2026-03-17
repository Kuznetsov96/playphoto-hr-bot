import { Prisma } from "@prisma/client";
import type { Location } from "@prisma/client";
import prisma from "../db/core.js";

export class LocationRepository {
    async findAll(): Promise<Location[]> {
        return prisma.location.findMany();
    }

    async findAllActive(): Promise<Location[]> {
        const locations = await prisma.location.findMany({
            where: { isHidden: false }
        });
        const posrednikovaLocs = ['Fly Kids Львів', 'Smile Park Lviv', 'Карамель Коломия', 'Карамель Шептицький', 'Volkland 3', 'Karamel Sambir'];
        const acquiringLocs = ['Smile Park Lviv', 'Dragon Park', 'Smile Park (Даринок)', 'Smile Park (Darynok)', 'Leoland', 'Leolend', 'Smile Park Київ', 'Smile Park Kharkiv'];

        return locations.map(l => {
            const isSmileKyiv = l.name === 'Smile Park Київ' || (l.legacyName === 'Smile Park Київ');
            const isDarynok = l.name.includes('Даринок') || l.name.includes('Darynok');
            
            // Priority: DB > Hardcoded
            const hasAcquiring = l.hasAcquiring || acquiringLocs.includes(l.name) || acquiringLocs.includes(l.legacyName || '') || isSmileKyiv || isDarynok;
            
            let fopId = l.fopId;
            if (!fopId || fopId === 'KUZNETSOV') { // Kuznetsov is default, check for overrides
                if (isSmileKyiv || l.name === 'Leoland') {
                    fopId = 'GUPALOVA';
                } else if (posrednikovaLocs.includes(l.name) || posrednikovaLocs.includes(l.legacyName || '')) {
                    fopId = 'POSREDNIKOVA';
                }
            }

            return { ...l, fopId, hasAcquiring };
        });
    }

    async findById(id: string): Promise<Location | null> {
        return prisma.location.findUnique({
            where: { id }
        });
    }

    async findAllCities(onlyVisible: boolean = true, candidateOnly: boolean = false): Promise<string[]> {
        const locations = await prisma.location.findMany({
            // candidateOnly means we filter for the candidate questionnaire
            where: (onlyVisible && candidateOnly) ? { isHiddenFromCandidates: false } : {},
            select: { city: true },
            distinct: ['city']
        });
        return locations.map(l => l.city);
    }

    async findActiveWithSheet(): Promise<Location[]> {
        const locations = await prisma.location.findMany({
            // @ts-ignore
            where: { sheet: { not: null }, isHidden: false }
        });
        const posrednikovaLocs = ['Fly Kids Львів', 'Smile Park Lviv', 'Карамель Коломия', 'Карамель Шептицький', 'Volkland 3', 'Karamel Sambir'];
        const acquiringLocs = ['Smile Park Lviv', 'Dragon Park', 'Smile Park (Даринок)', 'Smile Park (Darynok)', 'Leoland', 'Leolend', 'Smile Park Київ', 'Smile Park Kharkiv'];

        return locations.map(l => {
            const isSmileKyiv = l.name === 'Smile Park Київ' || (l.legacyName === 'Smile Park Київ');
            const isDarynok = l.name.includes('Даринок') || l.name.includes('Darynok');
            
            // Priority: DB > Hardcoded
            const hasAcquiring = l.hasAcquiring || acquiringLocs.includes(l.name) || acquiringLocs.includes(l.legacyName || '') || isSmileKyiv || isDarynok;
            
            let fopId = l.fopId;
            if (!fopId || fopId === 'KUZNETSOV') { // Kuznetsov is default, check for overrides
                if (isSmileKyiv || l.name === 'Leoland') {
                    fopId = 'GUPALOVA';
                } else if (posrednikovaLocs.includes(l.name) || posrednikovaLocs.includes(l.legacyName || '')) {
                    fopId = 'POSREDNIKOVA';
                }
            }

            return { ...l, fopId, hasAcquiring };
        });
    }

    async findByName(name: string): Promise<Location | null> {
        return prisma.location.findFirst({
            where: {
                OR: [
                    { name: { equals: name } },
                    { legacyName: { equals: name } },
                    { name: { contains: name } }
                ]
            }
        });
    }

    async findByCity(city: string, candidateOnly: boolean = false): Promise<Location[]> {
        const where: any = { city };
        if (candidateOnly) {
            where.isHiddenFromCandidates = false;
        }
        return prisma.location.findMany({ where });
    }

    async findByCityAdmin(city: string): Promise<Location[]> {
        return prisma.location.findMany({
            where: { city }
        });
    }

    async update(id: string, data: Prisma.LocationUpdateInput): Promise<Location> {
        return prisma.location.update({
            where: { id },
            data
        });
    }
    async countCandidatesByCity(city: string, status: any, extraWhere: any = {}): Promise<number> {
        return prisma.candidate.count({
            where: { city, status, ...extraWhere }
        });
    }

    async findWithWaitlist(): Promise<any[]> {
        return prisma.location.findMany({
            where: { candidates: { some: { status: "WAITLIST" as any } } },
            include: { _count: { select: { candidates: { where: { status: "WAITLIST" as any } } } } }
        });
    }
}

export const locationRepository = new LocationRepository();
