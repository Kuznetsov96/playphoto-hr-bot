import { randomUUID } from "node:crypto";
import type { Api } from "grammy";
import { Prisma, Role } from "@prisma/client";
import prisma from "../db/core.js";
import logger from "../core/logger.js";
import { logBusinessEvent, logSecurityEvent } from "../core/log-events.js";
import { findShiftLocationLabelCollisions } from "../utils/logistics-formatters.js";
import {
    AWS_BUSINESS_MIN_EMPLOYEES,
    AWS_BUSINESS_MIN_LOCATIONS,
    AWS_BUSINESS_SYNC_INTERVAL_MS,
} from "../config.js";
import {
    awsBusinessClient,
    type AwsBusinessSnapshot,
} from "./aws-business-client.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// The backend rejects a `links` payload larger than 500 entries outright.
const TELEGRAM_LINKS_CHUNK_SIZE = 500;

const LEGACY_SHEET_BY_LOCATION_CODE: Record<string, string> = {
    "volkland-1-baburka": "Volkland",
    "volkland-2-shevchenkivskyi": "Volkland 2",
    "volkland-3-peremohy": "Volkland 3",
    "fly-kids-kyiv": "FK Київ",
    "kidlandia-kyiv": "Kidlandia",
    "smile-park-darynok": "SP Даринок",
    "smile-park-kyiv-troieshchyna": "SP Київ",
    "karamel-kolomyia": "Карамель К",
    "dragon-park-lviv": "DragonP",
    "drive-city-lviv": "DriveCity",
    "fly-kids-lviv": "FK Львів",
    "leoland-lviv": "Leoland",
    "smile-park-lviv": "SP Львів",
    "fly-kids-rivne": "FK Рівне",
    "karamel-sambir": "Карамель С",
    "smile-park-kharkiv": "SP Харків",
    "dytiache-horyshche-khmelnytskyi": "DH Khmelnytskyi",
    "fantasy-town-cherkasy": "FT Черкаси",
    "karamel-sheptytskyi": "Карамель Ч",
};

interface SyncResult {
    generatedAt: string;
    activeBefore: number;
    activeAfter: number;
    employees: number;
    deactivatedMissingEmployees: number;
    locations: number;
    shiftsBefore: number;
    shiftsAfter: number;
    shiftsCreated: number;
    shiftsUpdated: number;
    shiftsDeleted: number;
}

export class AwsBusinessSyncService {
    private lastResult: SyncResult | null = null;
    private running: Promise<SyncResult> | null = null;

    async previewTeamSync(requestedBy?: number | bigint) {
        const snapshot = await this.fetchSnapshot();
        const activeBefore = await prisma.staffProfile.count({ where: { isActive: true } });
        const activeTelegramIds = new Set(
            snapshot.employees.filter((employee) => employee.status === "ACTIVE").map((employee) => employee.telegramId),
        );
        const currentActive = await prisma.staffProfile.findMany({
            where: { isActive: true },
            select: { id: true, fullName: true, user: { select: { telegramId: true } } },
        });
        const deactivationCandidates = currentActive
            .filter((staff) => !activeTelegramIds.has(staff.user.telegramId.toString()))
            .map((staff) => ({
                rowNumber: 0,
                fullName: staff.fullName,
                telegramId: staff.user.telegramId.toString(),
                existingUserId: "aws-snapshot",
                existingStaffId: staff.id,
                rawStatus: "Absent from complete AWS employee snapshot",
            }));
        const token = randomUUID();
        const preview = {
            token,
            generatedAt: snapshot.generatedAt,
            activeBefore,
            visibleStaffRows: snapshot.employees.length,
            hiddenStaffRows: 0,
            activeRows: activeTelegramIds.size,
            inactiveRows: snapshot.employees.length - activeTelegramIds.size,
            unknownStatusRows: 0,
            duplicateTelegramIds: [],
            deactivationCandidates,
            requiresConfirmation: deactivationCandidates.length > 0,
        };
        await prisma.systemState.upsert({
            where: { key: `team-sync-preview:${token}` },
            create: { key: `team-sync-preview:${token}`, value: JSON.stringify(preview) },
            update: { value: JSON.stringify(preview) },
        });
        logSecurityEvent({
            event: "security.staff.aws_snapshot_previewed",
            actorType: "admin",
            actorRole: "admin",
            result: "success",
            module: "aws-business-sync",
            operation: "previewTeamSync",
            telegramId: requestedBy,
            safeContext: {
                activeBefore,
                activeAfter: activeTelegramIds.size,
                deactivationCandidates: deactivationCandidates.length,
            },
        });
        return preview;
    }

    async syncTeam(_api?: Api) {
        const result = await this.syncAll();
        return {
            success: true,
            staffAdded: Math.max(0, result.employees - result.activeBefore),
            staffUpdated: result.employees,
            activeBefore: result.activeBefore,
            activeAfter: result.activeAfter,
            inactiveStaffProcessed: result.deactivatedMissingEmployees,
            inactiveStaffRemovedFromChats: 0,
            inactiveStaffRemovalFailures: [],
            unknownStatusRows: 0,
            duplicateTelegramIds: [],
            deactivationCandidates: [],
            teamMapping: {},
            blocklistRes: { success: true, count: 0, source: "AWS", error: undefined },
        };
    }

    async syncSchedule() {
        const result = await this.syncAll();
        return {
            success: true,
            count: result.shiftsAfter,
            shiftsBefore: result.shiftsBefore,
            shiftsAfter: result.shiftsAfter,
            created: result.shiftsCreated,
            updated: result.shiftsUpdated,
            deleted: result.shiftsDeleted,
            source: "AWS",
        };
    }

    async syncAll(): Promise<SyncResult> {
        if (this.running) return this.running;
        this.running = this.performSync();
        try {
            return await this.running;
        } finally {
            this.running = null;
        }
    }

    startLoop(): NodeJS.Timeout {
        const timer = setInterval(() => {
            void this.syncAll().catch((error: unknown) => {
                logger.error({ err: error }, "AWS business snapshot synchronization failed");
            });
        }, AWS_BUSINESS_SYNC_INTERVAL_MS);
        timer.unref();
        return timer;
    }

    private async performSync(): Promise<SyncResult> {
        const snapshot = await this.fetchSnapshot();
        const employeeResult = await this.syncEmployeesAndLocations(snapshot);
        await this.reportTelegramLinks(snapshot);
        const shiftResult = await this.syncShifts(snapshot);
        const result: SyncResult = {
            generatedAt: snapshot.generatedAt,
            ...employeeResult,
            ...shiftResult,
        };
        this.lastResult = result;
        await prisma.systemState.upsert({
            where: { key: "aws-business-sync:last" },
            create: { key: "aws-business-sync:last", value: JSON.stringify(result) },
            update: { value: JSON.stringify(result) },
        });
        logBusinessEvent({
            event: "bot.aws_business_snapshot.synced",
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "aws-business-sync",
            operation: "syncAll",
            safeContext: { ...result },
        });
        return result;
    }

    private async fetchSnapshot(): Promise<AwsBusinessSnapshot> {
        const today = localDate(new Date(), "Europe/Kyiv");
        const from = addDays(today, -30);
        const to = addDays(today, 62);
        const snapshot = await awsBusinessClient.snapshot(from, to);
        if (snapshot.locations.length < AWS_BUSINESS_MIN_LOCATIONS) {
            throw new Error(`AWS snapshot location guard failed: ${snapshot.locations.length}`);
        }
        if (snapshot.employees.length < AWS_BUSINESS_MIN_EMPLOYEES) {
            throw new Error(`AWS snapshot employee guard failed: ${snapshot.employees.length}`);
        }
        const employeeIds = new Set(snapshot.employees.map((employee) => employee.publicId));
        const locationIds = new Set(snapshot.locations.map((location) => location.publicId));
        if (
            snapshot.shifts.some(
                (shift) => !employeeIds.has(shift.employeePublicId) || !locationIds.has(shift.locationPublicId),
            )
        ) {
            throw new Error("AWS snapshot contains a shift with an unknown employee or location");
        }
        return snapshot;
    }

    private async syncEmployeesAndLocations(snapshot: AwsBusinessSnapshot) {
        const activeBefore = await prisma.staffProfile.count({ where: { isActive: true } });
        return prisma.$transaction(async (transaction) => {
            const locationIds = new Map<string, string>();
            for (const location of snapshot.locations) {
                const existing = await transaction.location.findFirst({
                    where: {
                        OR: [
                            { canonicalCode: location.canonicalCode },
                            { awsPublicId: location.publicId },
                            { sheet: LEGACY_SHEET_BY_LOCATION_CODE[location.canonicalCode] ?? "__missing__" },
                        ],
                    },
                    select: { id: true, address: true },
                });
                const saved = existing
                    ? await transaction.location.update({
                        where: { id: existing.id },
                        data: {
                            awsPublicId: location.publicId,
                            canonicalCode: location.canonicalCode,
                            name: location.name,
                            branch: location.branch,
                            city: location.city,
                            address: location.address,
                            isHidden: false,
                        },
                        select: { id: true },
                    })
                    : await transaction.location.create({
                        data: {
                            awsPublicId: location.publicId,
                            canonicalCode: location.canonicalCode,
                            name: location.name,
                            branch: location.branch,
                            city: location.city,
                            address: location.address,
                            isHidden: false,
                        },
                        select: { id: true },
                    });

                /**
                 * The canonical snapshot is authoritative, so replace the whole week rather
                 * than merging: a day the owner deleted upstream must disappear here too,
                 * otherwise a stale row would keep answering for it.
                 */
                await transaction.locationOpeningHours.deleteMany({ where: { locationId: saved.id } });
                if (location.openingHours.length > 0) {
                    await transaction.locationOpeningHours.createMany({
                        data: location.openingHours.map((day) => ({
                            locationId: saved.id,
                            dayOfWeek: day.dayOfWeek,
                            opens: day.opens,
                            closes: day.closes,
                        })),
                    });
                }
                locationIds.set(location.canonicalCode, saved.id);
            }

            /**
             * Shift labels omit the city, which is safe only while every venue sharing a name
             * with another carries a distinguishing `branch`. That is maintained in the canonical
             * catalogue, not here, so verify it on each snapshot instead of assuming it holds.
             *
             * A collision is reported, never repaired: inventing a discriminator is what produced
             * the bogus "Volkland 1", and the fix belongs in the catalogue. The sync itself is
             * unaffected — a duplicated label is a display defect, not a reason to reject data.
             */
            const labelCollisions = findShiftLocationLabelCollisions(snapshot.locations);
            for (const collision of labelCollisions) {
                logBusinessEvent({
                    event: "bot.location_label.collision",
                    level: "warn",
                    actorType: "system",
                    actorRole: "system",
                    result: "degraded",
                    reasonCode: "AMBIGUOUS_LOCATION_LABEL",
                    module: "aws-business-sync",
                    operation: "sync",
                    safeContext: {
                        label: collision.label,
                        canonicalCodes: collision.canonicalCodes,
                        hint: "add a canonical branch so photographers can tell these venues apart"
                    }
                });
            }

            const snapshotTelegramIds = snapshot.employees.map((employee) => BigInt(employee.telegramId));
            for (const employee of snapshot.employees) {
                const telegramId = BigInt(employee.telegramId);
                const user = await transaction.user.upsert({
                    where: { telegramId },
                    create: {
                        telegramId,
                        username: employee.telegramUsername,
                        firstName: employee.firstName,
                        lastName: employee.lastName,
                        role: Role.STAFF,
                    },
                    update: {
                        username: employee.telegramUsername,
                        firstName: employee.firstName,
                        lastName: employee.lastName,
                        ...(employee.status === "ACTIVE" ? { role: Role.STAFF } : {}),
                    },
                    select: { id: true },
                });
                const current = await transaction.staffProfile.findUnique({
                    where: { userId: user.id },
                    select: { id: true, deactivatedAt: true },
                });
                const isActive = employee.status === "ACTIVE";
                const primaryLocationCode = employee.assignments[0]?.locationCode;
                const locationId = primaryLocationCode ? locationIds.get(primaryLocationCode) ?? null : null;
                const data = {
                    awsEmployeePublicId: employee.publicId,
                    fullName: employee.fullName,
                    surnameNameDot: shortName(employee.lastName, employee.firstName),
                    phone: employee.phone,
                    birthDate: employee.birthDate ? new Date(`${employee.birthDate}T00:00:00.000Z`) : null,
                    isActive,
                    locationId,
                    deactivatedAt: isActive ? null : current?.deactivatedAt ?? new Date(),
                    deactivatedBy: isActive ? null : "system:aws-business-sync",
                    deactivatedSource: isActive ? null : "AWS_BUSINESS_SNAPSHOT",
                    deactivatedReason: isActive ? null : "Employee is deactivated in AWS",
                };
                if (current) {
                    await transaction.staffProfile.update({ where: { id: current.id }, data });
                } else {
                    await transaction.staffProfile.create({ data: { ...data, userId: user.id } });
                }
            }

            const deactivated = await transaction.staffProfile.updateMany({
                where: {
                    isActive: true,
                    user: { telegramId: { notIn: snapshotTelegramIds } },
                },
                data: {
                    isActive: false,
                    deactivatedAt: new Date(),
                    deactivatedBy: "system:aws-business-sync",
                    deactivatedSource: "AWS_BUSINESS_SNAPSHOT",
                    deactivatedReason: "Absent from complete AWS employee snapshot",
                },
            });
            return {
                activeBefore,
                activeAfter: snapshot.employees.filter((employee) => employee.status === "ACTIVE").length,
                employees: snapshot.employees.length,
                deactivatedMissingEmployees: deactivated.count,
                locations: snapshot.locations.length,
            };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000 });
    }

    /**
     * Tells the backend which snapshot telegram ids the bot recognises, so the
     * owner sees a verification badge when onboarding. A row in the bot's own
     * `User` table is the evidence: it means that person has interacted with
     * the bot. This is advisory only — a failure here must never fail the
     * sync, since photographers losing their schedule is far worse than a
     * stale badge.
     */
    private async reportTelegramLinks(snapshot: AwsBusinessSnapshot): Promise<void> {
        try {
            const snapshotTelegramIds = snapshot.employees.map((employee) => BigInt(employee.telegramId));
            const knownUsers = await prisma.user.findMany({
                where: { telegramId: { in: snapshotTelegramIds } },
                select: { telegramId: true, username: true, botBlockedAt: true },
            });
            const known = new Map(knownUsers.map((user) => [
                user.telegramId.toString(),
                { username: user.username, reachable: user.botBlockedAt === null },
            ]));
            const links = snapshot.employees.map((employee) => {
                const user = known.get(employee.telegramId);
                return {
                    telegramId: employee.telegramId,
                    found: user?.reachable ?? false,
                    ...(user?.username ? { username: user.username } : {}),
                };
            });
            for (let index = 0; index < links.length; index += TELEGRAM_LINKS_CHUNK_SIZE) {
                const chunk = links.slice(index, index + TELEGRAM_LINKS_CHUNK_SIZE);
                await awsBusinessClient.reportTelegramLinks(chunk);
            }
        } catch (error) {
            logger.warn({ err: error }, "could not report telegram links");
        }
    }

    private async syncShifts(snapshot: AwsBusinessSnapshot) {
        const from = new Date(`${snapshot.scheduleWindow.from}T00:00:00.000Z`);
        const toExclusive = new Date(new Date(`${snapshot.scheduleWindow.to}T00:00:00.000Z`).getTime() + DAY_MS);
        return prisma.$transaction(async (transaction) => {
            const existing = await transaction.workShift.findMany({
                where: { date: { gte: from, lt: toExclusive } },
                include: {
                    staff: { select: { id: true, user: { select: { telegramId: true } } } },
                    location: { select: { id: true, canonicalCode: true } },
                },
            });
            const shiftsBefore = existing.length;
            const existingByAwsId = new Map(
                existing.flatMap((shift) =>
                    shift.awsScheduledShiftPublicId ? [[shift.awsScheduledShiftPublicId, shift] as const] : [],
                ),
            );
            const legacyByNaturalKey = new Map<string, typeof existing>();
            for (const shift of existing) {
                if (shift.awsScheduledShiftPublicId) continue;
                const key = naturalShiftKey(
                    shift.staff.user.telegramId.toString(),
                    shift.location.canonicalCode,
                    shift.date.toISOString().slice(0, 10),
                );
                legacyByNaturalKey.set(key, [...(legacyByNaturalKey.get(key) ?? []), shift]);
            }
            const staff = await transaction.staffProfile.findMany({
                where: { user: { telegramId: { in: snapshot.shifts.map((shift) => BigInt(shift.employeeTelegramId)) } } },
                select: { id: true, user: { select: { telegramId: true } } },
            });
            const locations = await transaction.location.findMany({
                where: { canonicalCode: { in: snapshot.locations.map((location) => location.canonicalCode) } },
                select: { id: true, canonicalCode: true },
            });
            const staffIds = new Map(staff.map((item) => [item.user.telegramId.toString(), item.id]));
            const locationIds = new Map(locations.flatMap((item) => item.canonicalCode ? [[item.canonicalCode, item.id] as const] : []));
            const consumed = new Set<string>();
            let shiftsCreated = 0;
            let shiftsUpdated = 0;

            for (const shift of snapshot.shifts) {
                const staffId = staffIds.get(shift.employeeTelegramId);
                const locationId = locationIds.get(shift.locationCode);
                if (!staffId || !locationId) throw new Error("AWS shift projection mapping is incomplete");
                const data = {
                    staffId,
                    locationId,
                    date: new Date(`${shift.localDate}T00:00:00.000Z`),
                    startTime: new Date(shift.startsAt),
                    endTime: new Date(shift.endsAt),
                    awsScheduledShiftPublicId: shift.publicId,
                };
                const projected = existingByAwsId.get(shift.publicId);
                if (projected) {
                    await transaction.workShift.update({ where: { id: projected.id }, data });
                    consumed.add(projected.id);
                    shiftsUpdated++;
                    continue;
                }
                const key = naturalShiftKey(shift.employeeTelegramId, shift.locationCode, shift.localDate);
                const legacy = legacyByNaturalKey.get(key)?.shift();
                if (legacy) {
                    await transaction.workShift.update({ where: { id: legacy.id }, data });
                    consumed.add(legacy.id);
                    shiftsUpdated++;
                } else {
                    const created = await transaction.workShift.create({ data, select: { id: true } });
                    consumed.add(created.id);
                    shiftsCreated++;
                }
            }

            const staleIds = existing.filter((shift) => !consumed.has(shift.id)).map((shift) => shift.id);
            const deleted = staleIds.length
                ? await transaction.workShift.deleteMany({ where: { id: { in: staleIds } } })
                : { count: 0 };
            return {
                shiftsBefore,
                shiftsAfter: snapshot.shifts.length,
                shiftsCreated,
                shiftsUpdated,
                shiftsDeleted: deleted.count,
            };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000 });
    }
}

function naturalShiftKey(telegramId: string, locationCode: string | null, localDate: string): string {
    return `${telegramId}|${locationCode ?? "unmapped"}|${localDate}`;
}

function shortName(lastName: string, firstName: string): string {
    return `${lastName} ${[...firstName][0] ?? ""}.`.trim();
}

function localDate(date: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
}

function addDays(value: string, days: number): string {
    const date = new Date(`${value}T00:00:00.000Z`);
    return new Date(date.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

export const awsBusinessSyncService = new AwsBusinessSyncService();
