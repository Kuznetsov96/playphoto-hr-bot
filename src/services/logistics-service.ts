import prisma from '../db/core.js';
import { novaPoshtaService } from './nova-poshta-service.js';
import logger from '../core/logger.js';
import { ParcelStatus } from '@prisma/client';
import { workShiftRepository } from '../repositories/work-shift-repository.js';
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
                        data: { status: newStatus },
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
        // Staff is actively handling — do not override with NP status
        if (currentStatus === 'PICKUP_IN_PROGRESS' || currentStatus === 'VERIFYING') {
            return currentStatus;
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
                text = `🚨 <b>Parcel Rejected</b>\n\nPhotographer at ${loc} cannot pick up parcel ${ttn} today! (Rejections: ${parcel.rejectionCount})\n\nUrgent action required. ⚡️`;
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
        const kyivParts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Europe/Kyiv',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: 'numeric', hour12: false
        }).formatToParts(now);

        let y = 0, m = 0, d = 0, h = 0;
        for (const p of kyivParts) {
            if (p.type === 'year') y = parseInt(p.value);
            if (p.type === 'month') m = parseInt(p.value);
            if (p.type === 'day') d = parseInt(p.value);
            if (p.type === 'hour') h = parseInt(p.value);
        }

        if (h >= 20) d++;
        const shiftStart = new Date(Date.UTC(y, m - 1, d));
        const shiftEnd = new Date(Date.UTC(y, m - 1, d + 1));

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
                updatedAt: { lt: twoHoursAgo }
            },
            include: { responsibleStaff: { include: { user: true } }, location: true }
        });

        for (const parcel of parcels) {
            const tid = parcel.responsibleStaff?.user?.telegramId;
            if (!tid) continue;

            const kb = new InlineKeyboard()
                .text(LOGISTICS_TEXTS_STAFF.btn_photo, `parcel_photo_${parcel.id}`);

            await bot.api.sendMessage(Number(tid),
                `⏰ <b>Нагадування:</b> будь ласка, завантаж фото вмісту посилки <code>${parcel.ttn}</code> (${parcel.location?.name || ''}).\n\nНатисни кнопку нижче: 📸`,
                { parse_mode: 'HTML', reply_markup: kb }
            ).catch(err => logger.error({ err, ttn: parcel.ttn }, 'Failed to send photo reminder'));

            await prisma.parcel.update({
                where: { id: parcel.id },
                data: { photoReminderSentAt: new Date() }
            });

            logger.info({ ttn: parcel.ttn }, '📦 Photo upload reminder sent');
        }
    }

    /**
     * Alerts support about parcels stuck in ARRIVED for more than 2 days
     */
    private async checkStaleParcels() {
        const twoDaysAgo = new Date();
        twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

        const staleParcels = await prisma.parcel.findMany({
            where: {
                status: 'ARRIVED',
                updatedAt: { lt: twoDaysAgo }
            },
            include: { location: true }
        });

        for (const parcel of staleParcels) {
            const daysSinceUpdate = Math.floor((Date.now() - parcel.updatedAt.getTime()) / (1000 * 60 * 60 * 24));
            await this.notifySupport(parcel.id, 'DELAYED');
            logger.warn({ ttn: parcel.ttn, days: daysSinceUpdate }, '📦 Stale parcel alert sent');
        }
    }
}

export const logisticsService = new LogisticsService();
