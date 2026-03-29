import prisma from '../db/core.js';
import { novaPoshtaService } from './nova-poshta-service.js';
import logger from '../core/logger.js';
import { ParcelStatus } from '@prisma/client';
import { Bot, InlineKeyboard } from 'grammy';
import { BOT_TOKEN, TEAM_CHATS, NP_RECIPIENT_PHONE } from '../config.js';
import { LOGISTICS_TEXTS_STAFF, NP_LOCATIONS_MAP, NP_PERSONAL_FILTER } from '../constants/logistics-constants.js';
import { locationRepository } from '../repositories/location-repository.js';

const bot = new Bot(BOT_TOKEN);

export class LogisticsService {
    /**
     * Synchronize incoming parcels from Nova Poshta
     */
    async syncIncomingParcels() {
        logger.info('📦 Syncing incoming parcels from Nova Poshta...');
        const now = new Date();
        const dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.');
        const dateTo = now.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.');

        try {
            // 1. Auto-discover incoming parcels by recipient phone
            if (NP_RECIPIENT_PHONE) {
                const incoming = await novaPoshtaService.getIncomingByPhone(NP_RECIPIENT_PHONE, dateFrom, dateTo);
                if (incoming && Array.isArray(incoming)) {
                    logger.info(`📦 Found ${incoming.length} incoming parcels via phone`);
                    for (const doc of incoming) {
                        await this.processIncomingDocument(doc);
                    }
                }
            } else {
                logger.warn('📦 NP_RECIPIENT_PHONE not set — skipping auto-discovery');
            }

            // 2. Sync existing active parcels via Tracking API (Manual & Auto)
            await this.syncActiveParcelsStatus();

            // 3. Remind staff to upload content photo (2h after pickup)
            await this.remindPhotoUpload();

            // 4. Check for stale parcels (ARRIVED > 2 days)
            await this.checkStaleParcels();

            // 5. Remind staff who accepted but haven't picked up (2h before shift end)
            await this.remindBeforeShiftEnd();

            // 6. Hand off parcels stuck in PICKUP_IN_PROGRESS after shift end
            await this.handoffExpiredShiftParcels();
        } catch (error) {
            logger.error({ err: error }, '📦 Error during logistics sync');
        }
    }

    /**
     * Tracks statuses of all active parcels in DB
     */
    async syncActiveParcelsStatus() {
        const activeParcels = await prisma.parcel.findMany({
            where: {
                status: { notIn: ['COMPLETED', 'CANCELLED'] }
            }
        });

        if (activeParcels.length === 0) return;

        logger.info(`📦 Tracking status for ${activeParcels.length} active parcels...`);

        const trackingDocs = activeParcels.map(p => ({ DocumentNumber: p.ttn, Phone: "" }));
        const statuses = await novaPoshtaService.trackParcels(trackingDocs);

        if (statuses && Array.isArray(statuses)) {
            for (const statusDoc of statuses) {
                const parcel = activeParcels.find(p => p.ttn === statusDoc.Number);
                if (!parcel) continue;

                const npStatus = this.mapNPStatusToParcelStatus(statusDoc.StatusCode);
                const newStatus = this.resolveStatusTransition(parcel.status, npStatus, parcel.deliveryType);
                if (parcel.status !== newStatus) {
                    const updated = await prisma.parcel.update({
                        where: { id: parcel.id },
                        data: { status: newStatus, staleAlertSentAt: null },
                        include: { location: true }
                    });

                    logger.info({ ttn: updated.ttn, oldStatus: parcel.status, npStatus, newStatus }, '📦 Parcel status updated via Tracking API');
                    await this.notifyStaffOnShift(updated.id, newStatus);
                }
            }
        }
    }

    /**
     * Guards status transitions: prevents NP from auto-completing parcels
     * that haven't gone through staff pickup & photo verification flow.
     *
     * Rules:
     * - PICKUP_IN_PROGRESS / VERIFYING: staff is handling it — freeze, ignore NP updates
     * - EXPECTED/IN_TRANSIT → NP says DELIVERED/COMPLETED: cap at ARRIVED (staff must Accept first)
     * - ARRIVED → NP says COMPLETED: stay ARRIVED (staff must Accept first)
     */
    private resolveStatusTransition(currentStatus: ParcelStatus, npStatus: ParcelStatus, deliveryType: string | null): ParcelStatus {
        // VERIFYING: photos uploaded, awaiting admin — freeze completely
        if (currentStatus === 'VERIFYING') {
            return currentStatus;
        }

        // PICKUP_IN_PROGRESS: staff accepted. Allow NP DELIVERED through —
        // it means parcel was physically picked up from NP.
        if (currentStatus === 'PICKUP_IN_PROGRESS') {
            return npStatus === 'DELIVERED' ? 'DELIVERED' : currentStatus;
        }

        // Address delivery: NP gives DELIVERED when courier drops off.
        // This is legitimate — let it through so staff gets notified to upload photo.
        if (npStatus === 'DELIVERED' && deliveryType === 'Address') {
            return 'DELIVERED';
        }

        // NP says DELIVERED or COMPLETED but staff hasn't accepted yet — cap at ARRIVED
        // so the parcel stays visible and staff can go through the accept flow
        if (npStatus === 'DELIVERED' || npStatus === 'COMPLETED') {
            if (currentStatus === 'EXPECTED' || currentStatus === 'IN_TRANSIT' || currentStatus === 'ARRIVED') {
                return 'ARRIVED';
            }
        }

        return npStatus;
    }

    /**
     * Extracts warehouse/postomat number from NP document fields.
     * Tries explicit fields first, then parses from address string
     * (e.g. 'Поштомат "Нова Пошта" №38007' or 'Відділення №65').
     */
    private extractWarehouseNumber(doc: any): string {
        const explicit = doc.WarehouseRecipientNumber || doc.RecipientWarehouseIndex || '';
        if (explicit) return explicit;

        // Parse from address description: "№38007", "№ 65", "No38007"
        const addr = doc.RecipientAddressDescription || '';
        const match = addr.match(/№\s*(\d+)/);
        return match ? match[1] : '';
    }

    private async processIncomingDocument(doc: any) {
        // getIncomingDocumentsByPhone returns TrackingStatusCode
        // getDocumentList returns StatusCode — handle both

        const npCity = doc.CityRecipientDescription || '';
        const npWarehouse = this.extractWarehouseNumber(doc);
        const npAddress = (doc.RecipientAddressDescription || '').toLowerCase();

        // Ignore personal parcels (owner's private deliveries)
        if (npCity.includes(NP_PERSONAL_FILTER.city)) {
            if (NP_PERSONAL_FILTER.warehouses.includes(npWarehouse)) return;
            if (NP_PERSONAL_FILTER.addresses.some(a => npAddress.includes(a))) return;
        }

        const ttn = doc.Number;
        const statusCode = doc.TrackingStatusCode || doc.StatusCode || '1';
        let parcel = await prisma.parcel.findUnique({ where: { ttn } });

        if (!parcel) {
            const addressRef = doc.RecipientAddress || doc.RecipientAddressRef || null;
            const city = doc.CityRecipientDescription || null;
            const addressDesc = doc.RecipientAddressDescription || null;
            const warehouseNumber = npWarehouse || null;

            // Try to find matching location (by addressRef, warehouse number, address, or city)
            const location = await this.findLocationByMapping(addressRef, city, warehouseNumber, addressDesc);

            parcel = await prisma.parcel.create({
                data: {
                    ttn,
                    status: this.mapNPStatusToParcelStatus(statusCode),
                    locationId: location?.id || null,
                    deliveryType: warehouseNumber ? 'Warehouse' : 'Address',
                    description: doc.CargoDescription || doc.CargoDescriptionString || null,
                    scheduledDate: doc.ScheduledDeliveryDate ? new Date(doc.ScheduledDeliveryDate) : null,
                    npAddressRef: addressRef,
                    npCity: city,
                    npAddress: addressDesc,
                }
            });

            logger.info({ ttn, locationId: parcel.locationId, city, addressDesc }, '📦 New incoming parcel registered');

            // Auto-learn: save npAddressRef to location for future instant matching
            if (location && addressRef && !location.npAddressRef) {
                await prisma.location.update({
                    where: { id: location.id },
                    data: { npAddressRef: addressRef }
                });
                logger.info({ locationName: location.name, addressRef }, '📦 Auto-learned npAddressRef for location');
            }

            if (parcel.locationId) {
                await this.notifyStaffOnShift(parcel.id, parcel.status);
            } else {
                // Notify support about unmatched parcel
                await this.notifyUnmatchedParcel(parcel.id, city, addressDesc);
            }
        } else {
            // Skip cancelled/completed parcels — don't resurrect deleted ones
            if (parcel.status === 'CANCELLED' || parcel.status === 'COMPLETED') return;

            const npStatus = this.mapNPStatusToParcelStatus(statusCode);
            const newStatus = this.resolveStatusTransition(parcel.status, npStatus, parcel.deliveryType);
            if (parcel.status !== newStatus) {
                const updated = await prisma.parcel.update({
                    where: { id: parcel.id },
                    data: { status: newStatus }
                });

                await this.notifyStaffOnShift(updated.id, newStatus);
            }
        }
    }

    /**
     * Finds a location by NP data. Priority:
     * 1. npAddressRef exact match (learned)
     * 2. Warehouse number via NP_LOCATIONS_MAP
     * 3. Fuzzy address match (street + number in same city)
     * 4. City fallback (single location in city)
     */
    private async findLocationByMapping(addressRef: string | null, city: string | null, warehouseNumber: string | null, npAddress: string | null = null) {
        // 1. Exact match by NP Address Ref (learned from previous assignments)
        if (addressRef) {
            const byRef = await prisma.location.findFirst({ where: { npAddressRef: addressRef } });
            if (byRef) return byRef;

            // 1b. Learn from past parcels: same addressRef was already manually assigned
            const pastParcel = await prisma.parcel.findFirst({
                where: { npAddressRef: addressRef, locationId: { not: null } },
                include: { location: true },
                orderBy: { updatedAt: 'desc' }
            });
            if (pastParcel?.location) return pastParcel.location;
        }

        // 2. Warehouse number match via static NP_LOCATIONS_MAP
        if (warehouseNumber) {
            const mapEntry = NP_LOCATIONS_MAP.find(e => e.npPoints.includes(warehouseNumber));
            if (mapEntry) {
                const byName = await locationRepository.findByName(mapEntry.name);
                if (byName && (!mapEntry.city || byName.city === mapEntry.city)) return byName;
            }
        }

        // 3. Fuzzy address match — compare NP address against Location.address in same city
        if (city && npAddress) {
            const cityLocations = await prisma.location.findMany({
                where: { city, isHidden: false }
            });

            if (cityLocations.length > 1) {
                const match = this.fuzzyMatchAddress(npAddress, cityLocations);
                if (match) return match;
            }

            // 4. City fallback: if only one visible location in this city, auto-assign
            if (cityLocations.length === 1) return cityLocations[0];

            return null;
        }

        // 4. City fallback (no npAddress available)
        if (city) {
            const cityLocations = await prisma.location.findMany({
                where: { city, isHidden: false }
            });
            if (cityLocations.length === 1) return cityLocations[0];
        }

        return null;
    }

    /**
     * Extracts meaningful words from an address (street name keywords + building number).
     * Strips common prefixes like "вул.", "просп.", "буд.", "бульвар" etc.
     */
    private extractAddressTokens(addr: string): string[] {
        const noise = ['вул', 'вулиця', 'просп', 'проспект', 'бульв', 'бульвар', 'пров', 'провулок', 'буд', 'будинок', 'кв', 'м', 'тц', 'трц'];
        return addr
            .toLowerCase()
            .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()«»"""]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 2 && !noise.includes(w));
    }

    /**
     * Fuzzy-matches an NP address description against Location.address values.
     * Matching logic: extract street keywords + building number from both,
     * find the location with the most overlapping tokens (minimum 2).
     */
    private fuzzyMatchAddress(npAddress: string, locations: { id: string; address: string | null; name: string;[key: string]: any }[]) {
        const npTokens = this.extractAddressTokens(npAddress);
        if (npTokens.length === 0) return null;

        let bestMatch: typeof locations[0] | null = null;
        let bestScore = 0;

        for (const loc of locations) {
            if (!loc.address) continue;
            // Remove city prefix if present (e.g. "Львів, вул. ..." → "вул. ...")
            const locAddr = loc.address.replace(/^[^,]+,\s*/, '');
            const locTokens = this.extractAddressTokens(locAddr);

            const overlap = npTokens.filter(t => locTokens.some(lt => lt === t || lt.includes(t) || t.includes(lt)));
            if (overlap.length >= 2 && overlap.length > bestScore) {
                bestScore = overlap.length;
                bestMatch = loc;
            }
        }

        return bestMatch;
    }

    /**
     * Notifies support about a new parcel that couldn't be auto-matched to a location
     */
    private async notifyUnmatchedParcel(parcelId: string, city: string | null, address: string | null) {
        const text = `📦 <b>New Parcel — Location Unknown</b>\n\n` +
            `A new incoming parcel was detected but could not be auto-assigned to a location.\n\n` +
            `<b>City:</b> ${city || 'Unknown'}\n` +
            `<b>Address:</b> ${address || 'Unknown'}\n\n` +
            `Please assign a location manually.`;

        const kb = new InlineKeyboard()
            .text('📍 Assign Location', `admin_parcel_loc_${parcelId}`)
            .row()
            .text('📋 View Details', `admin_parcel_view_details_${parcelId}`);

        const options: any = { parse_mode: 'HTML', reply_markup: kb };
        if (TEAM_CHATS.LOGISTICS !== undefined) {
            options.message_thread_id = TEAM_CHATS.LOGISTICS;
        }

        await bot.api.sendMessage(TEAM_CHATS.SUPPORT, text, options)
            .catch(err => logger.error({ err }, 'Failed to notify support about unmatched parcel'));
    }

    /**
     * Notifies support about a parcel issue
     */
    async notifySupport(parcelId: string, type: 'NO_SHIFT' | 'REJECTED' | 'DELAYED') {
        const parcel = await prisma.parcel.findUnique({
            where: { id: parcelId },
            include: { location: true }
        });
        if (!parcel) return;

        let text = '';
        const ttn = `<code>${parcel.ttn}</code>`;
        const loc = `<b>${parcel.location?.name || 'Unknown'}</b>`;

        switch (type) {
            case 'NO_SHIFT':
                text = `⚠️ <b>No Photographer on Shift</b>\n\nParcel ${ttn} has arrived at ${loc}, but nobody is scheduled today.\n\nPlease coordinate manually. 📦`;
                break;
            case 'REJECTED':
                if (parcel.rejectionCount >= 2) {
                    text = `🚨 <b>Parcel Rejected</b>\n\nPhotographer at ${loc} cannot pick up parcel ${ttn} today! (Rejections: ${parcel.rejectionCount})\n\nUrgent action required. ⚡️`;
                } else {
                    text = `ℹ️ Photographer at ${loc} declined parcel ${ttn}. Someone else on shift may pick it up.`;
                }
                break;
            case 'DELAYED':
                text = `⏳ <b>Parcel Delayed</b>\n\nParcel ${ttn} at ${loc} has been waiting for too long!\n\nPlease check the status. 📦`;
                break;
        }

        const kb = new InlineKeyboard().text("⚙️ Manage Parcel", `admin_parcel_view_details_${parcelId}`);
        const targetChat = TEAM_CHATS.SUPPORT;
        const threadId = TEAM_CHATS.LOGISTICS;

        const options: any = {
            parse_mode: 'HTML',
            reply_markup: kb
        };

        if (threadId !== undefined) {
            options.message_thread_id = threadId;
        }

        await bot.api.sendMessage(targetChat, text, options).catch(err => logger.error({ err }, 'Failed to notify support about parcel'));
    }

    /**
     * Notifies staff on shift about a parcel
     */
    async notifyStaffOnShift(parcelId: string, triggerStatus: ParcelStatus) {
        const parcel = await prisma.parcel.findUnique({
            where: { id: parcelId },
            include: { location: true }
        });

        if (!parcel || !parcel.locationId) return;

        // After 20:00 Kyiv time, notify next day's staff instead of today's
        const now = new Date();
        const { shiftStart, shiftEnd } = this.getKyivShiftDateRange(now);

        const shifts = await prisma.workShift.findMany({
            where: {
                locationId: parcel.locationId,
                date: { gte: shiftStart, lt: shiftEnd }
            },
            include: { staff: true }
        });

        if (shifts.length === 0) {
            if (triggerStatus === 'ARRIVED' || triggerStatus === 'DELIVERED') {
                await this.notifySupport(parcelId, 'NO_SHIFT');
            }
            return;
        }

        for (const shift of shifts) {
            const user = await prisma.user.findUnique({ where: { id: shift.staff.userId } });
            if (!user) continue;

            let text = '';
            let kb = new InlineKeyboard();

            if (triggerStatus === 'EXPECTED') {
                text = LOGISTICS_TEXTS_STAFF.expected(parcel.ttn, parcel.location?.name || '');
            } else if (triggerStatus === 'ARRIVED') {
                text = LOGISTICS_TEXTS_STAFF.arrived(parcel.ttn, parcel.location?.name || '');
                kb.text(LOGISTICS_TEXTS_STAFF.btn_accept, `parcel_accept_${parcel.id}`)
                    .text(LOGISTICS_TEXTS_STAFF.btn_reject, `parcel_reject_${parcel.id}`);
            } else if (triggerStatus === 'DELIVERED' && parcel.deliveryType === 'Address') {
                text = LOGISTICS_TEXTS_STAFF.delivered_address(parcel.ttn, parcel.location?.name || '');
                kb.text(LOGISTICS_TEXTS_STAFF.btn_photo, `parcel_photo_${parcel.id}`);
            }

            if (text) {
                const options: any = { parse_mode: 'HTML' };
                if (kb.inline_keyboard.length > 0) {
                    options.reply_markup = kb;
                }
                await bot.api.sendMessage(Number(user.telegramId), text, options).catch(err => {
                    logger.error({ err, telegramId: user.telegramId }, 'Failed to notify staff about parcel');
                });
            }
        }
    }

    private mapNPStatusToParcelStatus(statusCode: string): ParcelStatus {
        switch (statusCode) {
            case '1': return 'EXPECTED';
            case '4':
            case '5':
            case '6': return 'IN_TRANSIT';
            case '7':
            case '8': return 'ARRIVED';
            case '9': return 'DELIVERED';
            case '10':
            case '11': return 'COMPLETED';
            default: return 'EXPECTED';
        }
    }

    /**
     * Returns today's (or tomorrow's after 20:00) shift date range in Kyiv time,
     * as UTC-anchored Date boundaries suitable for WorkShift.date queries.
     */
    private getKyivShiftDateRange(now: Date): { shiftStart: Date; shiftEnd: Date } {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Europe/Kyiv',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: 'numeric', hour12: false
        }).formatToParts(now);

        let y = 0, mo = 0, d = 0, h = 0;
        for (const p of parts) {
            if (p.type === 'year')  y  = parseInt(p.value);
            if (p.type === 'month') mo = parseInt(p.value);
            if (p.type === 'day')   d  = parseInt(p.value);
            if (p.type === 'hour')  h  = parseInt(p.value);
        }

        if (h >= 20) d++;
        const shiftStart = new Date(Date.UTC(y, mo - 1, d));
        const shiftEnd   = new Date(Date.UTC(y, mo - 1, d + 1));
        return { shiftStart, shiftEnd };
    }

    /**
     * Parses closing time from Location.schedule text for a given day of week.
     * Schedule format: "Пн-Пт — 15:00-21:00\nСб-Нд — 12:00-21:00"
     * Returns hour and minute of closing, or null if unparseable.
     */
    private parseScheduleCloseTime(schedule: string, dayOfWeek: number): { h: number; m: number } | null {
        // dayOfWeek: 0=Sun,1=Mon,...,6=Sat
        const DAY_RANGES: { days: number[]; pattern: RegExp }[] = [
            { days: [1, 2, 3, 4, 5], pattern: /пн.{0,5}пт/i },
            { days: [6, 0],          pattern: /сб.{0,5}нд/i },
            { days: [6],             pattern: /сб/i },
            { days: [0],             pattern: /нд/i },
            { days: [1],             pattern: /пн/i },
            { days: [2],             pattern: /вт/i },
            { days: [3],             pattern: /ср/i },
            { days: [4],             pattern: /чт/i },
            { days: [5],             pattern: /пт/i },
        ];

        for (const line of schedule.split('\n')) {
            for (const range of DAY_RANGES) {
                if (!range.days.includes(dayOfWeek)) continue;
                if (!range.pattern.test(line)) continue;

                // Support both hyphen and en/em-dash as time separator
                const timeMatch = line.match(/(\d{1,2}):(\d{2})[\s]*[-–—][\s]*(\d{1,2}):(\d{2})/);
                if (timeMatch) {
                    return { h: parseInt(timeMatch[3]!), m: parseInt(timeMatch[4]!) };
                }
            }
        }
        return null;
    }

    /**
     * Returns the shift end time for a location on a given date.
     * Uses WorkShift.endTime if available, otherwise parses Location.schedule.
     */
    private async getShiftEndTime(locationId: string, date: Date): Promise<Date | null> {
        const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
        const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

        // Try WorkShift.endTime first
        const shift = await prisma.workShift.findFirst({
            where: { locationId, date: { gte: dayStart, lt: dayEnd }, endTime: { not: null } },
            orderBy: { endTime: 'desc' }
        });
        if (shift?.endTime) return shift.endTime;

        // Fallback: parse Location.schedule
        const location = await prisma.location.findUnique({ where: { id: locationId } });
        if (!location?.schedule) return null;

        // Use Kyiv time to determine day of week — parse directly from formatToParts
        // to avoid timezone shifts when re-parsing a date string
        const kyivParts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Europe/Kyiv',
            weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(date);

        const weekdayNames: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        const weekdayStr = kyivParts.find(p => p.type === 'weekday')?.value ?? '';
        const kyivDow = weekdayNames[weekdayStr] ?? 0;

        const kyivDay   = kyivParts.find(p => p.type === 'day')?.value   ?? '01';
        const kyivMonth = kyivParts.find(p => p.type === 'month')?.value ?? '01';
        const kyivYear  = kyivParts.find(p => p.type === 'year')?.value  ?? '2000';

        const closeTime = this.parseScheduleCloseTime(location.schedule, kyivDow);
        if (!closeTime) return null;

        // Build close time anchored to Kyiv timezone (resolve actual UTC offset for DST)
        // Create a rough UTC estimate, then use Intl to find the real Kyiv offset for that moment
        const roughUtc = new Date(Date.UTC(parseInt(kyivYear), parseInt(kyivMonth) - 1, parseInt(kyivDay), closeTime.h, closeTime.m));
        const offsetMin = this.getKyivUtcOffsetMinutes(roughUtc);
        const closeUtc = new Date(roughUtc.getTime() - offsetMin * 60 * 1000);
        return closeUtc;
    }

    /**
     * Returns the UTC offset in minutes for Europe/Kyiv at a given moment.
     * Handles DST transitions automatically via Intl.
     */
    private getKyivUtcOffsetMinutes(date: Date): number {
        const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
        const kyivStr = date.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' });
        return (new Date(kyivStr).getTime() - new Date(utcStr).getTime()) / 60000;
    }

    /**
     * Sends a reminder to staff who accepted a parcel but haven't picked it up yet,
     * when 2 hours remain before their shift ends.
     */
    async remindBeforeShiftEnd() {
        const now = new Date();

        const parcels = await prisma.parcel.findMany({
            where: {
                status: 'PICKUP_IN_PROGRESS',
                responsibleStaffId: { not: null },
                locationId: { not: null },
                shiftEndReminderSentAt: null,
            },
            include: { responsibleStaff: { include: { user: true } }, location: true }
        });

        for (const parcel of parcels) {
            if (!parcel.locationId) continue;

            const endTime = await this.getShiftEndTime(parcel.locationId, now);
            if (!endTime) continue;

            const msUntilEnd = endTime.getTime() - now.getTime();
            // Remind if 1h45m–2h15m remain (30-min window to avoid re-triggering on each sync)
            if (msUntilEnd < 2.25 * 60 * 60 * 1000 && msUntilEnd > 1.75 * 60 * 60 * 1000) {
                const tid = parcel.responsibleStaff?.user?.telegramId;
                if (!tid) continue;

                const endTimeStr = endTime.toLocaleTimeString('uk-UA', {
                    timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit'
                });

                const kb = new InlineKeyboard()
                    .text(LOGISTICS_TEXTS_STAFF.btn_photo, `parcel_photo_${parcel.id}`);

                const sent = await bot.api.sendMessage(
                    Number(tid),
                    LOGISTICS_TEXTS_STAFF.pickup_reminder(parcel.ttn, endTimeStr),
                    { parse_mode: 'HTML', reply_markup: kb }
                ).then(() => true).catch(err => { logger.error({ err, ttn: parcel.ttn }, 'Failed to send shift-end reminder'); return false; });

                if (sent) {
                    await prisma.parcel.update({
                        where: { id: parcel.id },
                        data: { shiftEndReminderSentAt: new Date() }
                    });
                }

                logger.info({ ttn: parcel.ttn }, '📦 Shift-end reminder sent');
            }
        }
    }

    /**
     * After shift end: resets PICKUP_IN_PROGRESS parcels back to ARRIVED,
     * notifies the old responsible staff, then notifies the next shift.
     */
    async handoffExpiredShiftParcels() {
        const now = new Date();

        const parcels = await prisma.parcel.findMany({
            where: {
                status: { in: ['PICKUP_IN_PROGRESS', 'DELIVERED'] },
                responsibleStaffId: { not: null },
                locationId: { not: null },
            },
            include: { responsibleStaff: { include: { user: true } }, location: true }
        });

        for (const parcel of parcels) {
            if (!parcel.locationId) continue;

            const endTime = await this.getShiftEndTime(parcel.locationId, now);
            if (!endTime) continue;

            // Only hand off after shift end
            if (now.getTime() <= endTime.getTime()) continue;

            // If staff accepted AFTER shift end — they belong to the next shift, don't evict
            if (parcel.acceptedAt && parcel.acceptedAt.getTime() > endTime.getTime()) continue;

            // DELIVERED = physically picked up from NP. Don't reset to ARRIVED —
            // just remind the staff to upload photos. The parcel is already on location.
            if (parcel.status === 'DELIVERED') {
                const tid = parcel.responsibleStaff?.user?.telegramId;
                if (tid && parcel.contentPhotoIds.length === 0) {
                    const kb = new InlineKeyboard()
                        .text(LOGISTICS_TEXTS_STAFF.btn_photo, `parcel_photo_${parcel.id}`);
                    await bot.api.sendMessage(Number(tid),
                        `⏰ Зміна закінчилась, але фото посилки <code>${parcel.ttn}</code> ще не завантажено.\nБудь ласка, надішли фото вмісту. 📸`,
                        { parse_mode: 'HTML', reply_markup: kb }
                    ).catch(err => logger.error({ err, ttn: parcel.ttn }, 'Failed to send post-shift photo reminder'));
                }
                continue;
            }

            const oldTid = parcel.responsibleStaff?.user?.telegramId;

            // PICKUP_IN_PROGRESS but not picked up — reset for next shift
            await prisma.parcel.update({
                where: { id: parcel.id },
                data: {
                    status: 'ARRIVED',
                    responsibleStaffId: null,
                    acceptedAt: null,
                    shiftEndReminderSentAt: null,
                    photoReminderSentAt: null,
                    staleAlertSentAt: null,
                }
            });

            // Notify old staff
            if (oldTid) {
                await bot.api.sendMessage(
                    Number(oldTid),
                    LOGISTICS_TEXTS_STAFF.shift_ended_handoff(parcel.ttn),
                    { parse_mode: 'HTML' }
                ).catch(err => logger.error({ err, ttn: parcel.ttn }, 'Failed to send handoff message to old staff'));
            }

            logger.info({ ttn: parcel.ttn }, '📦 Parcel handed off after shift end');

            // Notify next shift (if already started)
            await this.notifyNextShiftAboutLeftover(parcel.id);
        }
    }

    /**
     * Notifies the staff of the next shift about a leftover parcel.
     * Called after handoff and also at start of each sync cycle.
     */
    async notifyNextShiftAboutLeftover(parcelId: string) {
        const now = new Date();
        const { shiftStart, shiftEnd } = this.getKyivShiftDateRange(now);

        const parcel = await prisma.parcel.findUnique({
            where: { id: parcelId },
            include: { location: true }
        });
        if (!parcel?.locationId) return;

        const shifts = await prisma.workShift.findMany({
            where: {
                locationId: parcel.locationId,
                date: { gte: shiftStart, lt: shiftEnd }
            },
            include: { staff: { include: { user: true } } }
        });

        for (const shift of shifts) {
            const tid = shift.staff?.user?.telegramId;
            if (!tid) continue;

            const kb = new InlineKeyboard()
                .text(LOGISTICS_TEXTS_STAFF.btn_accept, `parcel_accept_${parcel.id}`)
                .text(LOGISTICS_TEXTS_STAFF.btn_reject, `parcel_reject_${parcel.id}`);

            await bot.api.sendMessage(
                Number(tid),
                LOGISTICS_TEXTS_STAFF.leftover_parcel(parcel.ttn),
                { parse_mode: 'HTML', reply_markup: kb }
            ).catch(err => logger.error({ err, ttn: parcel.ttn }, 'Failed to notify next shift about leftover parcel'));
        }
    }

    /**
     * Reminds staff to upload content photo 2h after picking up a parcel
     */
    private async remindPhotoUpload() {
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

        const parcels = await prisma.parcel.findMany({
            where: {
                status: { in: ['PICKUP_IN_PROGRESS', 'DELIVERED'] },
                contentPhotoIds: { isEmpty: true },
                photoReminderSentAt: null,
                responsibleStaffId: { not: null },
                acceptedAt: { not: null, lt: twoHoursAgo }
            },
            include: { responsibleStaff: { include: { user: true } }, location: true }
        });

        for (const parcel of parcels) {
            const tid = parcel.responsibleStaff?.user?.telegramId;
            if (!tid) continue;

            const kb = new InlineKeyboard()
                .text(LOGISTICS_TEXTS_STAFF.btn_photo, `parcel_photo_${parcel.id}`);

            const sent = await bot.api.sendMessage(Number(tid),
                `⏰ <b>Нагадування:</b> будь ласка, завантаж фото вмісту посилки <code>${parcel.ttn}</code> (${parcel.location?.name || ''}).\n\nНатисни кнопку нижче: 📸`,
                { parse_mode: 'HTML', reply_markup: kb }
            ).then(() => true).catch(err => { logger.error({ err, ttn: parcel.ttn }, 'Failed to send photo reminder'); return false; });

            if (sent) {
                await prisma.parcel.update({
                    where: { id: parcel.id },
                    data: { photoReminderSentAt: new Date() }
                });
                logger.info({ ttn: parcel.ttn }, '📦 Photo upload reminder sent');
            }
        }
    }

    /**
     * Alerts support about parcels stuck in ARRIVED or DELIVERED (picked up but no photo) for more than 2 days
     */
    private async checkStaleParcels() {
        const twoDaysAgo = new Date();
        twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

        const staleParcels = await prisma.parcel.findMany({
            where: {
                status: { in: ['ARRIVED', 'DELIVERED'] },
                updatedAt: { lt: twoDaysAgo },
                staleAlertSentAt: null,
            },
            include: { location: true }
        });

        for (const parcel of staleParcels) {
            const daysSinceUpdate = Math.floor((Date.now() - parcel.updatedAt.getTime()) / (1000 * 60 * 60 * 24));
            await this.notifySupport(parcel.id, 'DELAYED');
            await prisma.parcel.update({ where: { id: parcel.id }, data: { staleAlertSentAt: new Date() } });
            logger.warn({ ttn: parcel.ttn, days: daysSinceUpdate }, '📦 Stale parcel alert sent');
        }
    }
}

export const logisticsService = new LogisticsService();
