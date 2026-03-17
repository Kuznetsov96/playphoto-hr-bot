import Database from 'better-sqlite3';
import { PrismaClient, Role, TicketStatus } from '@prisma/client';
import path from 'path';
import fs from 'fs';

const prisma = new PrismaClient();
const sqlitePath = path.resolve(process.cwd(), 'db/hr_bot_backup.db');

if (!fs.existsSync(sqlitePath)) {
    console.error(`❌ SQLite database not found at ${sqlitePath}`);
    process.exit(1);
}

const sqlite = new Database(sqlitePath, { readonly: true });

function parseDate(dateStr: any): Date | null {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
}

async function migrate() {
    console.log("🚀 Starting migration from participants.db to PostgreSQL...");

    try {
        // 1. Migrate Users
        console.log("Migrating Users...");
        const users = sqlite.prepare("SELECT * FROM users").all();
        for (const u of users) {
            const user: any = u;

            // Map roles
            let role: Role = Role.CANDIDATE;
            if (user.is_admin) role = Role.ADMIN;
            else if (user.is_photographer) role = Role.CANDIDATE; // We'll link to StaffProfile later

            await prisma.user.upsert({
                where: { telegramId: BigInt(user.user_id) },
                update: {
                    username: user.username,
                    firstName: user.full_name?.split(' ')[0] || null,
                    lastName: user.full_name?.split(' ').slice(1).join(' ') || null,
                    role: role
                },
                create: {
                    telegramId: BigInt(user.user_id),
                    username: user.username,
                    firstName: user.full_name?.split(' ')[0] || null,
                    lastName: user.full_name?.split(' ').slice(1).join(' ') || null,
                    role: role,
                }
            });

            // If it's a photographer, create/update StaffProfile
            if (user.is_photographer) {
                const dbUser = await prisma.user.findUnique({ where: { telegramId: BigInt(user.user_id) } });
                if (dbUser) {
                    await prisma.staffProfile.upsert({
                        where: { userId: dbUser.id },
                        update: {
                            fullName: user.full_name || 'Unknown',
                            phone: user.phone,
                            birthDate: parseDate(user.birthday),
                            isActive: Boolean(user.is_active)
                        },
                        create: {
                            userId: dbUser.id,
                            fullName: user.full_name || 'Unknown',
                            phone: user.phone,
                            birthDate: parseDate(user.birthday),
                            isActive: Boolean(user.is_active)
                        }
                    });
                }
            }
        }
        console.log(`✅ ${users.length} Users/Staff processed.`);

        // 2. Migrate Support Tickets
        console.log("Migrating Support Tickets...");
        const tickets = sqlite.prepare("SELECT * FROM support_tickets").all();
        for (const t of tickets) {
            const ticket: any = t;
            const dbUser = await prisma.user.findUnique({ where: { telegramId: BigInt(ticket.user_id) } });

            if (dbUser) {
                // Map status
                let status: TicketStatus = TicketStatus.OPEN;
                if (ticket.status === 'closed') status = TicketStatus.CLOSED;
                else if (ticket.status === 'in_progress') status = TicketStatus.IN_PROGRESS;

                await prisma.supportTicket.create({
                    data: {
                        userId: dbUser.id,
                        status: status,
                        isUrgent: Boolean(ticket.is_urgent),
                        issueText: ticket.issue_text || 'No text provided',
                        topicId: ticket.topic_id,
                        createdAt: new Date(ticket.created_at),
                    }
                });
            }
        }
        console.log(`✅ ${tickets.length} Support Tickets migrated.`);

        console.log("\n🎉 DATA MIGRATION COMPLETED SUCCESSFULLY!");

    } catch (e) {
        console.error("❌ Migration Failed:", e);
    } finally {
        await prisma.$disconnect();
        sqlite.close();
    }
}

migrate();
