import prisma from '../db/core.js';
import { novaPoshtaService } from './nova-poshta-service.js';
import logger from '../core/logger.js';
import { ParcelStatus } from '@prisma/client';
import { Bot, InlineKeyboard } from 'grammy';
import { BOT_TOKEN, TEAM_CHATS, NP_RECIPIENT_PHONE } from '../config.js';
import { LOGISTICS_TEXTS_STAFF, NP_LOCATIONS_MAP, NP_PERSONAL_FILTER } from '../constants/logistics-constants.js';
import { logBusinessEvent } from '../core/log-events.js';
import { buildSignedCallback } from '../utils/signed-callback.js';
import { isDuplicateManualProxyRequest } from '../modules/staff/handlers/logistics-rejection.js';

const bot = new Bot(BOT_TOKEN);

type LogisticsSupportIssueType = 'NO_SHIFT' | 'REJECTED' | 'DELAYED' | 'SHIPMENT_LOCKED' | 'MANUAL_PROXY';

export class LogisticsService {
    /**
     * Synchronize incoming parcels from Nova Poshta
     */
    async syncIncomingParcels() {
        const now = new Date();
        const dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.');
        const dateTo = now.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.');

        try {
            // 1. Auto-discover incoming parcels by recipient phone
            if (NP_RECIPIENT_PHONE) {
                const incoming = await novaPoshtaService.getIncomingByPhone(NP_RECIPIENT_PHONE, dateFrom, dateTo);
                if (incoming && Array.isArray(incoming)) {
                    for (const doc of incoming) {
                        await this.processIncomingDocument(doc);
                    }
                }
            } else {
                logger.warn('Nova Poshta auto-discovery skipped because recipient phone is not configured');
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
            logger.error({ err: error }, 'Logistics synchronization failed');
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

                    logBusinessEvent({
                        event: "logistics.parcel.status_updated",
                        actorType: "system",
                        actorRole: "system",
                        result: "success",
                        module: "logistics-service",
                        operation: "syncActiveParcelsStatus",
                        safeContext: {
                            parcelId: updated.id,
                            oldStatus: parcel.status,
                            newStatus,
                            statusSource: "nova_poshta_tracking",
                        },
                    });
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
    * - Address delivery: DELIVERED means courier dropoff, allow direct photo flow
    * - Warehouse/postomat: DELIVERED/COMPLETED means NP already handed it out, allow photo flow
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

        // For warehouse/postomat parcels, DELIVERED/COMPLETED means the parcel was already
        // handed out by Nova Poshta. Don't send staff into trustee flow again.
        if (npStatus === 'DELIVERED' || npStatus === 'COMPLETED') {
            if (currentStatus === 'EXPECTED' || currentStatus === 'IN_TRANSIT' || currentStatus === 'ARRIVED') {
                return 'DELIVERED';
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

            logBusinessEvent({
                event: "logistics.parcel.registered",
                actorType: "system",
                actorRole: "system",
                result: "success",
                module: "logistics-service",
                operation: "processIncomingDocument",
                safeContext: {
                    parcelId: parcel.id,
                    locationId: parcel.locationId,
                    city,
                    deliveryType: parcel.deliveryType,
                },
            });

            // Auto-learn: save npAddressRef to location for future instant matching
            if (location && addressRef && !location.npAddressRef) {
                await prisma.location.update({
                    where: { id: location.id },
                    data: { npAddressRef: addressRef }
                });
                logger.debug({ locationName: location.name }, 'Logistics location address reference learned');
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
            const warehouseMatch = await this.findLocationByWarehouseMapping(warehouseNumber, city);
            if (warehouseMatch) {
                return warehouseMatch;
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

    private normalizeCityName(city: string | null): string | null {
        if (!city) return null;

        return city
            .toLowerCase()
            .replace(/^м\.\s*/i, '')
            .replace(/^місто\s+/i, '')
            .split(',')[0]!
            .trim();
    }

    private async findLocationByWarehouseMapping(warehouseNumber: string, city: string | null) {
        const normalizedCity = this.normalizeCityName(city);
        const matchingEntries = NP_LOCATIONS_MAP.filter((entry) => {
            if (!entry.npPoints.includes(warehouseNumber)) return false;
            if (!normalizedCity || !entry.city) return true;
            return this.normalizeCityName(entry.city) === normalizedCity;
        });

        if (matchingEntries.length === 0) return null;
        if (!normalizedCity && matchingEntries.length > 1) return null;

        for (const entry of matchingEntries) {
            const byName = await prisma.location.findFirst({
                where: {
                    isHidden: false,
                    ...(entry.city ? { city: entry.city } : {}),
                    OR: [
                        { name: { equals: entry.name } },
                        { legacyName: { equals: entry.name } },
                        { name: { contains: entry.name } },
                        { legacyName: { contains: entry.name } },
                    ]
                }
            });

            if (byName) return byName;
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
            .catch(err => logger.error({ err, parcelId }, 'Logistics unmatched parcel support notification failed'));
    }

    /**
     * Notifies support about a parcel issue
     */
    async notifySupport(parcelId: string, type: LogisticsSupportIssueType) {
        const parcel = await prisma.parcel.findUnique({
            where: { id: parcelId },
            include: { location: true, responsibleStaff: true }
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
            case 'SHIPMENT_LOCKED':
                text =
                    `🚧 <b>NP Shipment Locked</b>\n\n` +
                    `Parcel ${ttn} for ${loc} is already in a state where trustee creation via API is blocked.\n\n` +
                    `<b>Photographer:</b> ${parcel.responsibleStaff?.fullName || 'Unknown'}\n` +
                    `<b>Current status:</b> ${parcel.status}\n` +
                    `<b>Last NP error:</b> ${parcel.npTrusteeError || 'Unknown'}\n\n` +
                    `Please verify who actually received the parcel and make sure the content photo flow is completed.`;
                break;
            case 'MANUAL_PROXY':
                text =
                    `📝 <b>Manual NP Proxy Required</b>\n\n` +
                    `Parcel ${ttn} for ${loc} needs a manual trustee/proxy assignment in Nova Poshta.\n\n` +
                    `<b>Photographer:</b> ${parcel.responsibleStaff?.fullName || 'Unknown'}\n` +
                    `<b>Phone:</b> ${parcel.recipientPhone || parcel.responsibleStaff?.npPhone || parcel.responsibleStaff?.phone || 'Unknown'}\n` +
                    `<b>Status:</b> ${parcel.status}\n\n` +
                    `After you create the proxy manually, confirm it below so the photographer can continue with the content photo flow.`;
                break;
        }

        const kb = new InlineKeyboard();
        if (type === 'MANUAL_PROXY') {
            kb.text("✅ Proxy Created", `admin_parcel_manual_proxy_done_${parcelId}`).row();
        }
        kb.text("⚙️ Manage Parcel", `admin_parcel_view_details_${parcelId}`);
        const targetChat = TEAM_CHATS.SUPPORT;
        const threadId = TEAM_CHATS.LOGISTICS;

        const options: any = {
            parse_mode: 'HTML',
            reply_markup: kb
        };

        if (threadId !== undefined) {
            options.message_thread_id = threadId;
        }

        await bot.api.sendMessage(targetChat, text, options).catch(err => logger.error({ err, parcelId, type }, 'Logistics support notification failed'));
    }

    async requestManualProxy(parcelId: string, params: { telegramId?: number; requestedPhone: string }) {
        const parcel = await prisma.parcel.findUnique({
            where: { id: parcelId },
            include: { location: true, responsibleStaff: true }
        });
        if (!parcel) return null;

        if (isDuplicateManualProxyRequest(
            parcel.npTrusteeLastAttemptAt,
            parcel.npTrusteeError,
            params.requestedPhone,
            parcel.recipientPhone,
        )) {
            return { parcel, duplicate: true } as const;
        }

        const updated = await prisma.parcel.update({
            where: { id: parcelId },
            data: {
                recipientPhone: params.requestedPhone,
                npTrusteeOrderRef: null,
                npTrusteeOrderNumber: null,
                npTrusteeError: 'MANUAL_PROXY_REQUESTED',
                npTrusteeLastAttemptAt: new Date()
            },
            include: { location: true, responsibleStaff: true }
        });

        logBusinessEvent({
            event: 'logistics.parcel.manual_proxy_requested',
            actorType: 'staff',
            actorRole: 'staff',
            telegramId: params.telegramId,
            result: 'success',
            reasonCode: 'MANUAL_PROXY',
            module: 'logistics-service',
            operation: 'requestManualProxy',
            safeContext: {
                parcelId,
                ttn: updated.ttn,
                requestedPhone: params.requestedPhone,
                locationName: updated.location?.name || 'Unknown',
                responsibleStaffId: updated.responsibleStaffId,
                responsibleStaffName: updated.responsibleStaff?.fullName || null
            }
        });

        await this.notifySupport(parcelId, 'MANUAL_PROXY');
        return { parcel: updated, duplicate: false } as const;
    }

    async notifyManualProxyReady(parcelId: string) {
        const parcel = await prisma.parcel.findUnique({
            where: { id: parcelId },
            include: { responsibleStaff: true, location: true }
        });
        if (!parcel?.responsibleStaffId || !parcel.responsibleStaff) return null;

        const user = await prisma.user.findUnique({ where: { id: parcel.responsibleStaff.userId } });
        if (!user) return null;

        const kb = new InlineKeyboard().text(LOGISTICS_TEXTS_STAFF.btn_photo, buildSignedCallback("pph", parcel.id));
        const text =
            `✅ <b>Доручення оформлено.</b>\n\n` +
            `Посилку <code>${parcel.ttn}</code> для <b>${parcel.location?.name || 'локації'}</b> вже можна забирати у Новій Пошті.\n\n` +
            `Коли забереш посилку, натисни кнопку нижче й надішли фото вмісту.`;

        await bot.api.sendMessage(Number(user.telegramId), text, {
            parse_mode: 'HTML',
            reply_markup: kb
        }).catch(err => logger.error({ err, parcelId, telegramId: user.telegramId }, 'Logistics manual proxy ready notification failed'));

        return parcel;
    }

    async handleShipmentLocked(
        parcelId: string,
        params: {
            telegramId?: number;
            attemptedPhone?: string;
            errorMessage?: string | undefined;
            shouldNotifySupport?: boolean;
            source: 'parcel_phone_ok' | 'parcel_phone_change';
        }
    ) {
        const parcel = await prisma.parcel.findUnique({
            where: { id: parcelId },
            include: { location: true, responsibleStaff: true }
        });
        if (!parcel) return;

        const shouldMarkDelivered = !['DELIVERED', 'VERIFYING', 'COMPLETED', 'CANCELLED'].includes(parcel.status);

        if (shouldMarkDelivered) {
            await prisma.parcel.update({
                where: { id: parcelId },
                data: {
                    status: 'DELIVERED',
                    staleAlertSentAt: null,
                }
            });

            logBusinessEvent({
                event: 'logistics.parcel.status_updated',
                actorType: params.telegramId ? 'staff' : 'system',
                actorRole: params.telegramId ? 'staff' : 'system',
                telegramId: params.telegramId,
                result: 'success',
                module: 'logistics-service',
                operation: 'handleShipmentLocked',
                reasonCode: 'SHIPMENT_LOCKED',
                safeContext: {
                    parcelId,
                    oldStatus: parcel.status,
                    newStatus: 'DELIVERED',
                    statusSource: 'np_trustee_locked',
                },
            });
        }

        logBusinessEvent({
            event: 'logistics.parcel.trustee_locked',
            level: 'warn',
            actorType: params.telegramId ? 'staff' : 'system',
            actorRole: params.telegramId ? 'staff' : 'system',
            telegramId: params.telegramId,
            result: 'failed',
            reasonCode: 'SHIPMENT_LOCKED',
            module: 'logistics-service',
            operation: 'handleShipmentLocked',
            safeContext: {
                parcelId,
                ttn: parcel.ttn,
                locationName: parcel.location?.name || 'Unknown',
                deliveryType: parcel.deliveryType,
                parcelStatus: shouldMarkDelivered ? 'DELIVERED' : parcel.status,
                attemptedPhone: params.attemptedPhone,
                responsibleStaffId: parcel.responsibleStaffId,
                responsibleStaffName: parcel.responsibleStaff?.fullName || null,
                hasContentPhotos: parcel.contentPhotoIds.length > 0,
                source: params.source,
                shouldNotifySupport: Boolean(params.shouldNotifySupport),
                npTrusteeError: params.errorMessage || parcel.npTrusteeError || null,
            },
        });

        if (params.shouldNotifySupport) {
            await this.notifySupport(parcelId, 'SHIPMENT_LOCKED');
        }
    }

    async markPickedUpManually(
        parcelId: string,
        params: {
            telegramId?: number;
            source?: 'admin_logistics';
            notifyStaff?: boolean;
        } = {}
    ) {
        const parcel = await prisma.parcel.findUnique({
            where: { id: parcelId },
            include: { location: true, responsibleStaff: true }
        });
        if (!parcel) return null;
        if (parcel.status === 'COMPLETED' || parcel.status === 'CANCELLED') {
            return parcel;
        }

        const updated = await prisma.parcel.update({
            where: { id: parcelId },
            data: {
                status: 'DELIVERED',
                acceptedAt: parcel.acceptedAt ?? new Date(),
                staleAlertSentAt: null,
                photoReminderSentAt: null,
                shiftEndReminderSentAt: null,
            },
            include: { location: true, responsibleStaff: true }
        });

        logBusinessEvent({
            event: 'logistics.parcel.manual_pickup_marked',
            actorType: 'admin',
            actorRole: 'admin',
            telegramId: params.telegramId,
            result: 'success',
            reasonCode: 'MANUAL_PICKUP',
            module: 'logistics-service',
            operation: 'markPickedUpManually',
            safeContext: {
                parcelId,
                ttn: updated.ttn,
                oldStatus: parcel.status,
                newStatus: updated.status,
                locationName: updated.location?.name || 'Unknown',
                deliveryType: updated.deliveryType,
                responsibleStaffId: updated.responsibleStaffId,
                responsibleStaffName: updated.responsibleStaff?.fullName || null,
                hasContentPhotos: updated.contentPhotoIds.length > 0,
                source: params.source || 'admin_logistics',
            },
        });

        if (params.notifyStaff !== false) {
            await this.notifyStaffOnShift(parcelId, 'DELIVERED');
        }

        return updated;
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
                    .text(LOGISTICS_TEXTS_STAFF.btn_reject, buildSignedCallback("prj", parcel.id));
            } else if (triggerStatus === 'DELIVERED') {
                text = parcel.deliveryType === 'Address'
                    ? LOGISTICS_TEXTS_STAFF.delivered_address(parcel.ttn, parcel.location?.name || '')
                    : LOGISTICS_TEXTS_STAFF.delivered_pickup_completed(parcel.ttn, parcel.location?.name || '');
                kb.text(LOGISTICS_TEXTS_STAFF.btn_photo, buildSignedCallback("pph", parcel.id));
            }

            if (text) {
                const options: any = { parse_mode: 'HTML' };
                if (kb.inline_keyboard.length > 0) {
                    options.reply_markup = kb;
                }
                await bot.api.sendMessage(Number(user.telegramId), text, options).catch(err => {
                    logger.error({ err, telegramId: user.telegramId, parcelId }, 'Logistics staff notification failed');
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
            if (p.type === 'year') y = parseInt(p.value);
            if (p.type === 'month') mo = parseInt(p.value);
            if (p.type === 'day') d = parseInt(p.value);
            if (p.type === 'hour') h = parseInt(p.value);
        }

        if (h >= 20) d++;
        const shiftStart = new Date(Date.UTC(y, mo - 1, d));
        const shiftEnd = new Date(Date.UTC(y, mo - 1, d + 1));
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
            { days: [6, 0], pattern: /сб.{0,5}нд/i },
            { days: [6], pattern: /сб/i },
            { days: [0], pattern: /нд/i },
            { days: [1], pattern: /пн/i },
            { days: [2], pattern: /вт/i },
            { days: [3], pattern: /ср/i },
            { days: [4], pattern: /чт/i },
            { days: [5], pattern: /пт/i },
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

        const kyivDay = kyivParts.find(p => p.type === 'day')?.value ?? '01';
        const kyivMonth = kyivParts.find(p => p.type === 'month')?.value ?? '01';
        const kyivYear = kyivParts.find(p => p.type === 'year')?.value ?? '2000';

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

    private getKyivCalendarDateRange(now: Date, dayOffset = 0): { shiftStart: Date; shiftEnd: Date } {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Europe/Kyiv',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).formatToParts(now);

        let y = 0, mo = 0, d = 0;
        for (const p of parts) {
            if (p.type === 'year') y = parseInt(p.value);
            if (p.type === 'month') mo = parseInt(p.value);
            if (p.type === 'day') d = parseInt(p.value);
        }

        const shiftStart = new Date(Date.UTC(y, mo - 1, d + dayOffset));
        const shiftEnd = new Date(Date.UTC(y, mo - 1, d + dayOffset + 1));
        return { shiftStart, shiftEnd };
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
                    .text(LOGISTICS_TEXTS_STAFF.btn_photo, buildSignedCallback("pph", parcel.id));

                const sent = await bot.api.sendMessage(
                    Number(tid),
                    LOGISTICS_TEXTS_STAFF.pickup_reminder(parcel.ttn, endTimeStr),
                    { parse_mode: 'HTML', reply_markup: kb }
                ).then(() => true).catch(err => { logger.error({ err, ttn: parcel.ttn, parcelId: parcel.id }, 'Logistics shift-end reminder delivery failed'); return false; });

                if (sent) {
                    await prisma.parcel.update({
                        where: { id: parcel.id },
                        data: { shiftEndReminderSentAt: new Date() }
                    });
                }

                logBusinessEvent({
                    event: "logistics.parcel.shift_end_reminder_sent",
                    actorType: "system",
                    actorRole: "system",
                    result: "success",
                    module: "logistics-service",
                    operation: "remindBeforeShiftEnd",
                    safeContext: {
                        parcelId: parcel.id,
                    },
                });
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
                const freshParcel = await prisma.parcel.findUnique({
                    where: { id: parcel.id },
                    include: { responsibleStaff: { include: { user: true } } }
                });

                const tid = freshParcel?.responsibleStaff?.user?.telegramId;
                const shouldSendPostShiftReminder = Boolean(
                    freshParcel &&
                    freshParcel.status === 'DELIVERED' &&
                    freshParcel.contentPhotoIds.length === 0 &&
                    freshParcel.shiftEndReminderSentAt === null &&
                    tid
                );

                if (shouldSendPostShiftReminder) {
                    const kb = new InlineKeyboard()
                        .text(LOGISTICS_TEXTS_STAFF.btn_photo, buildSignedCallback("pph", parcel.id));

                    const sent = await bot.api.sendMessage(
                        Number(tid),
                        `⏰ Зміна закінчилась, але фото посилки <code>${parcel.ttn}</code> ще не завантажено.\nБудь ласка, надішли фото вмісту. 📸`,
                        { parse_mode: 'HTML', reply_markup: kb }
                    ).then(() => true).catch(err => {
                        logger.error({ err, ttn: parcel.ttn, parcelId: parcel.id }, 'Logistics post-shift photo reminder delivery failed');
                        return false;
                    });

                    if (sent) {
                        await prisma.parcel.update({
                            where: { id: parcel.id },
                            data: { shiftEndReminderSentAt: new Date() }
                        });
                    }
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
                    recipientPhone: null,
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
                ).catch(err => logger.error({ err, ttn: parcel.ttn, parcelId: parcel.id }, 'Logistics handoff notification to previous staff failed'));
            }

            logBusinessEvent({
                event: "logistics.parcel.handed_off_after_shift",
                actorType: "system",
                actorRole: "system",
                result: "success",
                module: "logistics-service",
                operation: "handoffExpiredShiftParcels",
                safeContext: {
                    parcelId: parcel.id,
                },
            });

            // Notify next shift (if already started)
            await this.notifyNextShiftAboutLeftover(parcel.id);
        }
    }

    /**
     * Notifies the staff of the next shift about a leftover parcel.
     * Called after handoff and also at start of each sync cycle.
     */
    private async notifyShiftAboutLeftover(parcelId: string, shiftStart: Date, shiftEnd: Date) {
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
                .text(LOGISTICS_TEXTS_STAFF.btn_reject, buildSignedCallback("prj", parcel.id));

            await bot.api.sendMessage(
                Number(tid),
                LOGISTICS_TEXTS_STAFF.leftover_parcel(parcel.ttn),
                { parse_mode: 'HTML', reply_markup: kb }
            ).catch(err => logger.error({ err, ttn: parcel.ttn, parcelId: parcel.id }, 'Logistics leftover parcel notification to next shift failed'));
        }
    }

    async notifyNextShiftAboutLeftover(parcelId: string) {
        const now = new Date();
        const { shiftStart, shiftEnd } = this.getKyivShiftDateRange(now);
        await this.notifyShiftAboutLeftover(parcelId, shiftStart, shiftEnd);
    }

    async notifyTomorrowShiftAboutLeftover(parcelId: string) {
        const { shiftStart, shiftEnd } = this.getKyivCalendarDateRange(new Date(), 1);
        await this.notifyShiftAboutLeftover(parcelId, shiftStart, shiftEnd);
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
                .text(LOGISTICS_TEXTS_STAFF.btn_photo, buildSignedCallback("pph", parcel.id));

            const sent = await bot.api.sendMessage(Number(tid),
                `⏰ <b>Нагадування:</b> будь ласка, завантаж фото вмісту посилки <code>${parcel.ttn}</code> (${parcel.location?.name || ''}).\n\nНатисни кнопку нижче: 📸`,
                { parse_mode: 'HTML', reply_markup: kb }
            ).then(() => true).catch(err => { logger.error({ err, ttn: parcel.ttn, parcelId: parcel.id }, 'Logistics photo reminder delivery failed'); return false; });

            if (sent) {
                await prisma.parcel.update({
                    where: { id: parcel.id },
                    data: { photoReminderSentAt: new Date() }
                });
                logBusinessEvent({
                    event: "logistics.parcel.photo_reminder_sent",
                    actorType: "system",
                    actorRole: "system",
                    result: "success",
                    module: "logistics-service",
                    operation: "remindPhotoUpload",
                    safeContext: {
                        parcelId: parcel.id,
                    },
                });
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
                OR: [
                    { status: 'ARRIVED' },
                    { status: 'DELIVERED', contentPhotoIds: { isEmpty: true } }
                ],
                updatedAt: { lt: twoDaysAgo },
                staleAlertSentAt: null,
            },
            include: { location: true }
        });

        for (const parcel of staleParcels) {
            const daysSinceUpdate = Math.floor((Date.now() - parcel.updatedAt.getTime()) / (1000 * 60 * 60 * 24));
            await this.notifySupport(parcel.id, 'DELAYED');
            await prisma.parcel.update({ where: { id: parcel.id }, data: { staleAlertSentAt: new Date() } });
            logger.warn({ ttn: parcel.ttn, days: daysSinceUpdate, parcelId: parcel.id }, 'Logistics stale parcel alert sent');
        }
    }
}

export const logisticsService = new LogisticsService();
