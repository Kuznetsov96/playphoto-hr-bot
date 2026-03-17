
import Database from 'better-sqlite3';
import { PrismaClient, TicketStatus, FinanceLogType } from '@prisma/client';
import path from 'path';
import fs from 'fs';

const prisma = new PrismaClient();

// Absolute path to the legacy database
const LEGACY_DB_PATH = process.env.LEGACY_DB_PATH || '/Users/vitaliikuznetsov/PlayPhoto/playphoto_bot/participants.db';

async function migrate() {
    if (!fs.existsSync(LEGACY_DB_PATH)) {
        console.error(`❌ Legacy database not found at ${LEGACY_DB_PATH}`);
        process.exit(1);
    }

    console.log('🔌 Connecting to legacy database...');
    const legacyDb = new Database(LEGACY_DB_PATH, { readonly: true });

    console.log('🚀 Starting migration...');

    try {
        // 1. Migrate Users & StaffProfiles
        console.log('\n👤 Migrating Users and StaffProfiles...');
        const users = legacyDb.prepare(`
            SELECT user_id, username, full_name, is_admin, is_photographer, is_active 
            FROM users
        `).all() as any[];

        let userCount = 0;
        let staffCount = 0;

        for (const u of users) {
            const telegramId = BigInt(u.user_id);

            // Create or Update User
            const user = await prisma.user.upsert({
                where: { telegramId },
                update: {
                    username: u.username,
                    firstName: u.full_name ? u.full_name.split(' ')[0] : undefined,
                    lastName: u.full_name ? u.full_name.split(' ').slice(1).join(' ') : undefined,
                    role: u.is_admin ? 'ADMIN' : (u.is_photographer ? 'CANDIDATE' : 'CANDIDATE'), // Default to CANDIDATE, upgrade later if needed
                },
                create: {
                    telegramId,
                    username: u.username,
                    firstName: u.full_name ? u.full_name.split(' ')[0] : undefined,
                    lastName: u.full_name ? u.full_name.split(' ').slice(1).join(' ') : undefined,
                    role: u.is_admin ? 'ADMIN' : 'CANDIDATE',
                }
            });
            userCount++;

            // If photographer and active, create StaffProfile
            // Note: In legacy DB, is_photographer=1 meant they are in the system.
            if (u.is_photographer && u.is_active) {
                // Try to parse birthdate
                let birthDate: Date | null = null;
                if (u.birthday) {
                    const parts = u.birthday.split('.');
                    if (parts.length === 3) {
                        birthDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
                    } else if (parts.length === 2) {
                        // Assuming current year or generic year if only day/month provided, or skip
                        // Better to keep null if year is missing to avoid fake ages
                    }
                }

                await prisma.staffProfile.upsert({
                    where: { userId: user.id },
                    update: {
                        fullName: u.full_name || 'Unknown',
                        phone: u.phone,
                        birthDate: birthDate,
                        isActive: Boolean(u.is_active),
                        // onboardingDate could be bot_activated_at
                    },
                    create: {
                        userId: user.id,
                        fullName: u.full_name || 'Unknown',
                        phone: u.phone,
                        birthDate: birthDate,
                        isActive: Boolean(u.is_active),
                    }
                });
                staffCount++;
            }
        }
        console.log(`✅ Processed ${userCount} users and ${staffCount} staff profiles.`);

        // 2. Locations (Dictionary)
        console.log('\n📍 Migrating Locations...');
        // We fetch distinct locations from schedule to populate the Location table
        const locations = legacyDb.prepare(`SELECT DISTINCT location_name FROM schedule`).all() as any[];

        let locCount = 0;
        for (const l of locations) {
            const name = l.location_name;
            if (!name) continue;

            const existing = await prisma.location.findFirst({
                where: { OR: [{ name: name }, { legacyName: name }] }
            });

            if (!existing) {
                // Determine city - difficult without mapping, will default to "Unknown" or try to infer
                await prisma.location.create({
                    data: {
                        name: name,
                        legacyName: name, // Mark this as imported
                        city: "З'ясувати", // Admin will update
                        isHidden: false,
                        neededCount: 1
                    }
                });
                locCount++;
            }
        }
        console.log(`✅ Synced ${locCount} new locations.`);

        // 3. Work Shifts (Schedule)
        console.log('\n📅 Migrating Schedule...');
        const schedule = legacyDb.prepare(`
            SELECT user_id, work_date, location_name FROM schedule 
            WHERE work_date >= date('now', '-3 months')
        `).all() as any[];

        let shiftCount = 0;
        for (const s of schedule) {
            const telegramId = BigInt(s.user_id);
            const user = await prisma.user.findUnique({ where: { telegramId }, include: { staffProfile: true } });

            if (!user || !user.staffProfile) continue;

            // Find location
            const loc = await prisma.location.findFirst({
                where: { OR: [{ name: s.location_name }, { legacyName: s.location_name }] }
            });

            if (loc) {
                const date = new Date(s.work_date);

                // Check duplicate
                const existingShift = await prisma.workShift.findFirst({
                    where: {
                        staffId: user.staffProfile.id,
                        date: date,
                        locationId: loc.id
                    }
                });

                if (!existingShift) {
                    await prisma.workShift.create({
                        data: {
                            staffId: user.staffProfile.id,
                            locationId: loc.id,
                            date: date
                        }
                    });
                    shiftCount++;
                }
            }
        }
        console.log(`✅ Migrated ${shiftCount} shifts.`);

        // 4. Support Tickets
        console.log('\n🎫 Migrating Support Tickets...');
        const tickets = legacyDb.prepare(`
            SELECT * FROM support_tickets 
            ORDER BY created_at DESC LIMIT 200
        `).all() as any[];

        let ticketCount = 0;
        for (const t of tickets) {
            const telegramId = BigInt(t.user_id);
            const user = await prisma.user.findUnique({ where: { telegramId } });

            if (!user) continue; // Skip if user not found (deleted?)

            let status: TicketStatus = 'OPEN';
            if (t.status === 'in_progress') status = 'IN_PROGRESS';
            if (t.status === 'closed') status = 'CLOSED';

            await prisma.supportTicket.create({
                data: {
                    userId: user.id,
                    status: status,
                    isUrgent: Boolean(t.is_urgent),
                    issueText: t.issue_text || 'No text',
                    topicId: t.topic_id,
                    assignedAdminId: t.assigned_admin_id ? String(t.assigned_admin_id) : null,
                    createdAt: new Date(t.created_at),
                    // If closed, we don't have closedAt in schema yet but we have it in legacy.
                    // Assuming updatedAt ~ closedAt for closed tickets if we wanted.
                }
            });
            ticketCount++;
        }
        console.log(`✅ Migrated ${ticketCount} tickets.`);

        // 5. Finance Logs
        console.log('\n💰 Migrating Finance Logs...');
        const logs = legacyDb.prepare(`
            SELECT * FROM finance_logs 
            ORDER BY created_at DESC LIMIT 500
        `).all() as any[];

        let financeCount = 0;
        for (const l of logs) {
            let type: FinanceLogType = 'INCOME';
            if (l.log_type === 'expense') type = 'EXPENSE';

            await prisma.financeLog.create({
                data: {
                    type: type,
                    amount: l.amount,
                    category: l.category,
                    comment: l.comment,
                    fopAccount: l.fop_account,
                    locationName: l.location_name,
                    isSynced: Boolean(l.is_synced),
                    createdAt: new Date(l.created_at),
                    adminId: l.admin_id ? String(l.admin_id) : null,
                }
            });
            financeCount++;
        }
        console.log(`✅ Migrated ${financeCount} finance logs.`);

        console.log('\n✨ Database migration completed successfully!');

    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    } finally {
        legacyDb.close();
        await prisma.$disconnect();
    }
}

migrate();
