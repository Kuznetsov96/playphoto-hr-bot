import { Prisma } from "@prisma/client";
import type { Location } from "@prisma/client";
import prisma from "../db/core.js";
import { TtlCache } from "../utils/ttl-cache.js";

/**
 * Кеш довідника локацій для анкети кандидатки.
 *
 * Плагін @grammyjs/menu перебудовує динамічну клавіатуру не лише при
 * рендері, а й при кожному натисканні — щоб зіставити кнопку з обробником.
 * Без кешу список міст читався з бази двічі за один тап, а множинний вибір
 * локацій робив запит на кожну поставлену галочку.
 *
 * Тридцять секунд: локації міняються раз на тиждень, тож найгірше, що може
 * статися, — нова локація з'явиться у списку на пів хвилини пізніше.
 */
const LOCATION_CACHE_TTL_MS = 30_000;
const citiesCache = new TtlCache<string[]>(LOCATION_CACHE_TTL_MS);
const byCityCache = new TtlCache<Location[]>(LOCATION_CACHE_TTL_MS);
/**
 * Той самий прийом, що й для citiesCache/byCityCache: майстер масової постановки задач
 * читає повний довідник активних локацій на КОЖЕН тап чекбокса (місто, scope, локація,
 * отримувач) — без кешу один прогін майстра на пів сотні співробітників робив стільки ж
 * запитів findAllActive, скільки було тапів. Той самий TTL і той самий clear() у update().
 */
const activeCache = new TtlCache<Location[]>(LOCATION_CACHE_TTL_MS);

export class LocationRepository {
    async findAll(): Promise<Location[]> {
        return prisma.location.findMany();
    }

    /**
     * Точки, які зараз працюють: ті, що прийшли в останньому знімку вебаппу
     * (знімок несе лише ACTIVE, закриті синк ховає). Рядки без `awsPublicId`
     * вебапп не знає зовсім — службові чи старі ручні, точками їх не рахуємо.
     */
    async countOperating(): Promise<number> {
        return prisma.location.count({
            where: { isHidden: false, awsPublicId: { not: null } }
        });
    }

    async findAllActive(): Promise<Location[]> {
        return activeCache.get("active", async () => {
            const locations = await prisma.location.findMany({
                where: { isHidden: false }
            });
            const posrednikovaLocs = ['Fly Kids Львів', 'Smile Park Lviv', 'Карамель Коломия', 'Карамель Шептицький', 'Volkland 2', 'Volkland 2 (Шевчик)', 'Volkland 3', 'Karamel Sambir'];
            const karpukLocs = ['Volkland', 'Fly Kids'];
            const acquiringLocs = ['Smile Park Lviv', 'Dragon Park', 'Smile Park (Даринок)', 'Smile Park (Darynok)', 'Leoland', 'Leolend', 'Smile Park Київ', 'Smile Park Kharkiv'];

            return locations.map(l => {
                const isSmileKyiv = l.name === 'Smile Park Київ' || (l.legacyName === 'Smile Park Київ');
                const isDarynok = l.name.includes('Даринок') || l.name.includes('Darynok');
                const isKarpukTerminalLocation =
                    (l.name === 'Volkland' && l.city === 'Запоріжжя') ||
                    (l.name === 'Fly Kids' && l.city === 'Рівне') ||
                    (l.legacyName === 'Volkland 1 (Бабурка)' && l.city === 'Запоріжжя') ||
                    (l.legacyName === 'Fly Kids Рівне' && l.city === 'Рівне');

                // Priority: DB > Hardcoded
                const hasAcquiring = l.hasAcquiring || acquiringLocs.includes(l.name) || acquiringLocs.includes(l.legacyName || '') || isSmileKyiv || isDarynok;

                let fopId = l.fopId;
                if (!fopId || fopId === 'KUZNETSOV') { // Kuznetsov is default, check for overrides
                    if (isSmileKyiv || l.name === 'Leoland') {
                        fopId = 'POSREDNIKOVA';
                    } else if (isKarpukTerminalLocation || karpukLocs.includes(l.legacyName || '')) {
                        fopId = 'KARPUK';
                    } else if (posrednikovaLocs.includes(l.name) || posrednikovaLocs.includes(l.legacyName || '')) {
                        fopId = 'POSREDNIKOVA';
                    }
                }

                return { ...l, fopId, hasAcquiring };
            });
        });
    }

    async findById(id: string): Promise<Location | null> {
        return prisma.location.findUnique({
            where: { id }
        });
    }

    /**
     * Локація за канонічним кодом вебаппа — тим самим, що бот віддає в
     * дзеркало як `locationCode` (recruiting-mirror/snapshot.ts). Без кешу:
     * викликається поштучно командою рекрутера, а не на кожен тап меню.
     */
    async findByCanonicalCode(canonicalCode: string): Promise<Location | null> {
        return prisma.location.findUnique({
            where: { canonicalCode }
        });
    }

    async findAllCities(onlyVisible: boolean = true, candidateOnly: boolean = false): Promise<string[]> {
        return citiesCache.get(`${onlyVisible}:${candidateOnly}`, async () => {
            const locations = await prisma.location.findMany({
                // candidateOnly means we filter for the candidate questionnaire
                where: (onlyVisible && candidateOnly) ? { isHiddenFromCandidates: false } : {},
                select: { city: true },
                distinct: ['city'],
                orderBy: { city: 'asc' }
            });
            return locations.map(l => l.city);
        });
    }

    async findActiveWithSheet(): Promise<Location[]> {
        const locations = await prisma.location.findMany({
            // @ts-ignore
            where: { sheet: { not: null }, isHidden: false }
        });
        const posrednikovaLocs = ['Fly Kids Львів', 'Smile Park Lviv', 'Карамель Коломия', 'Карамель Шептицький', 'Volkland 2', 'Volkland 2 (Шевчик)', 'Volkland 3', 'Karamel Sambir'];
        const karpukLocs = ['Volkland', 'Fly Kids'];
        const acquiringLocs = ['Smile Park Lviv', 'Dragon Park', 'Smile Park (Даринок)', 'Smile Park (Darynok)', 'Leoland', 'Leolend', 'Smile Park Київ', 'Smile Park Kharkiv'];

        return locations.map(l => {
            const isSmileKyiv = l.name === 'Smile Park Київ' || (l.legacyName === 'Smile Park Київ');
            const isDarynok = l.name.includes('Даринок') || l.name.includes('Darynok');
            const isKarpukTerminalLocation =
                (l.name === 'Volkland' && l.city === 'Запоріжжя') ||
                (l.name === 'Fly Kids' && l.city === 'Рівне') ||
                (l.legacyName === 'Volkland 1 (Бабурка)' && l.city === 'Запоріжжя') ||
                (l.legacyName === 'Fly Kids Рівне' && l.city === 'Рівне');
            
            // Priority: DB > Hardcoded
            const hasAcquiring = l.hasAcquiring || acquiringLocs.includes(l.name) || acquiringLocs.includes(l.legacyName || '') || isSmileKyiv || isDarynok;
            
            let fopId = l.fopId;
            if (!fopId || fopId === 'KUZNETSOV') { // Kuznetsov is default, check for overrides
                if (isSmileKyiv || l.name === 'Leoland') {
                    fopId = 'POSREDNIKOVA';
                } else if (isKarpukTerminalLocation || karpukLocs.includes(l.legacyName || '')) {
                    fopId = 'KARPUK';
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
        return byCityCache.get(`${city}:${candidateOnly}`, async () => {
            const where: any = { city };
            if (candidateOnly) {
                where.isHiddenFromCandidates = false;
            }
            // Порядок явний. Без нього Postgres віддає рядки як лежать на диску, а
            // синк переписує кожну локацію на кожному проході — кнопки міняються
            // місцями між показом і тапом, і плагін меню відповідає кандидатці
            // «Menu was outdated» замість вибору.
            return prisma.location.findMany({ where, orderBy: [{ name: 'asc' }, { branch: 'asc' }, { id: 'asc' }] });
        });
    }

    async findByCityAdmin(city: string): Promise<Location[]> {
        return prisma.location.findMany({
            where: { city }
        });
    }

    async update(id: string, data: Prisma.LocationUpdateInput): Promise<Location> {
        const updated = await prisma.location.update({
            where: { id },
            data
        });
        // Довідник змінився — кеш анкети скидаємо одразу, щоб приховану
        // локацію не пропонували кандидаткам ще пів хвилини.
        citiesCache.clear();
        byCityCache.clear();
        activeCache.clear();
        return updated;
    }
    async countCandidatesByCity(city: string, status: any, extraWhere: any = {}): Promise<number> {
        return prisma.candidate.count({
            where: { city, status, ...extraWhere }
        });
    }

    async findWithWaitlist(): Promise<any[]> {
        return prisma.location.findMany({
            where: { candidates: { some: { status: { in: ["WAITLIST", "WAITLIST_HR"] } as any } } },
            include: { _count: { select: { candidates: { where: { status: { in: ["WAITLIST", "WAITLIST_HR"] } as any } } } } }
        });
    }
}

export const locationRepository = new LocationRepository();
