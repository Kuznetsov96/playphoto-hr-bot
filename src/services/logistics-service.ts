import prisma from '../db/core.js';
import { novaPoshtaService } from './nova-poshta-service.js';
import logger from '../core/logger.js';
import { ParcelStatus } from '@prisma/client';
import { workShiftRepository } from '../repositories/work-shift-repository.js';
import { Bot, InlineKeyboard } from 'grammy';
import { BOT_TOKEN, TEAM_CHATS } from '../config.js';
import { NP_LOCATIONS_MAP, LOGISTICS_TEXTS_STAFF } from '../constants/logistics-constants.js';

const bot = new Bot(BOT_TOKEN);

export class LogisticsService {
    /**
     * Synchronize incoming parcels from Nova Poshta
     */
    /**
     * Synchronize incoming parcels from Nova Poshta
     */
    async syncIncomingParcels() {
        logger.info('📦 Syncing incoming parcels from Nova Poshta...');
        const now = new Date();
        const dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.'); 
        const dateTo = now.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.');

        try {
            // 1. Sync via Document List (for auto-discovery)
            const counterparties = await novaPoshtaService.callApi('Counterparty', 'getCounterparties', {
                CounterpartyProperty: 'Recipient'
            });

            if (counterparties && Array.isArray(counterparties)) {
                for (const cp of counterparties) {
                    const incoming = await novaPoshtaService.getIncomingParcels(dateFrom, dateTo, cp.Ref);
                    if (incoming && Array.isArray(incoming)) {
                        for (const doc of incoming) {
                            await this.processIncomingDocument(doc);
                        }
                    }
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            // 2. Sync existing active parcels via Tracking API (Manual & Auto)
            await this.syncActiveParcelsStatus();
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

                const newStatus = this.mapNPStatusToParcelStatus(statusDoc.StatusCode);
                if (parcel.status !== newStatus) {
                    const updated = await prisma.parcel.update({
                        where: { id: parcel.id },
                        data: { status: newStatus },
                        include: { location: true }
                    });
                    
                    logger.info({ ttn: updated.ttn, newStatus }, '📦 Parcel status updated via Tracking API');
                    await this.notifyStaffOnShift(updated.id, newStatus);
                }
            }
        }
    }

    private async processIncomingDocument(doc: any) {

        // Ensure this is an INCOMING parcel (we are the recipient)
        // Check if RecipientRef corresponds to one of our counterparties or matches our phones/locations.
        // Usually, when we pass RecipientRef to getDocumentList, we get those we receive.
        // But we double check to be safe and avoid "Outgoing" items.
        
        const ttn = doc.Number;
        let parcel = await prisma.parcel.findUnique({ where: { ttn } });
        
        if (!parcel) {
            // Check if we have locations mapping for this parcel
            const warehouseIndex = doc.RecipientWarehouseIndex;
            const addressRef = doc.RecipientAddressRef;
            
            const location = await this.findLocationByMapping(warehouseIndex, addressRef);
            
            // If we found a location, it's highly likely an incoming parcel to our shops.
            // If not found, we still check the status and Recipient info from NP.
            
            parcel = await prisma.parcel.create({
                data: {
                    ttn,
                    status: this.mapNPStatusToParcelStatus(doc.StatusCode),
                    locationId: location?.id || null,
                    deliveryType: addressRef ? 'Address' : 'Warehouse',
                    description: doc.CargoDescription,
                    scheduledDate: doc.ScheduledDeliveryDate ? new Date(doc.ScheduledDeliveryDate) : null,
                }
            });

            logger.info({ ttn, locationId: parcel.locationId }, '📦 New incoming parcel registered');
            
            if (parcel.locationId) {
                await this.notifyStaffOnShift(parcel.id, parcel.status);
            }
        } else {
            const newStatus = this.mapNPStatusToParcelStatus(doc.StatusCode);
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
     * Finds a location using the static mapping
     */
    private async findLocationByMapping(warehouseIndex: string, addressRef: string) {
        // 1. Search by warehouse number (e.g. '80')
        if (warehouseIndex) {
            const mapEntry = NP_LOCATIONS_MAP.find(m => m.npPoints.includes(warehouseIndex));
            if (mapEntry) {
                return prisma.location.findFirst({ where: { name: mapEntry.name, city: mapEntry.city } });
            }
        }

        // 2. Search by address mapping (if implemented in DB)
        if (addressRef) {
            return prisma.location.findFirst({ where: { npAddressRef: addressRef } });
        }

        return null;
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

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const shifts = await prisma.workShift.findMany({
            where: {
                locationId: parcel.locationId,
                date: { gte: today, lt: tomorrow }
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
            case '9':
            case '10':
            case '11': return 'COMPLETED';
            default: return 'EXPECTED';
        }
    }
}

export const logisticsService = new LogisticsService();
