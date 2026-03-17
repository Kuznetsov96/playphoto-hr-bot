import Database from 'better-sqlite3';
import { PrismaClient } from '@prisma/client';
import path from 'path';
import fs from 'fs';

const prisma = new PrismaClient();

// The path to the legacy database file we just copied
const sqlitePath = path.resolve(process.cwd(), 'legacy_participants.db');

if (!fs.existsSync(sqlitePath)) {
    console.error(`❌ Legacy SQLite database not found at ${sqlitePath}`);
    process.exit(1);
}

const sqlite = new Database(sqlitePath, { readonly: true });

async function migrateTickets() {
    console.log("🚀 Starting incremental ticket migration...");

    try {
        const legacyTickets = sqlite.prepare("SELECT * FROM support_tickets").all();
        console.log(`📡 Found ${legacyTickets.length} tickets in legacy DB.`);

        let migratedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        for (const t of legacyTickets) {
            const legacy: any = t;

            // 1. Check if it already exists in Postgres
            const existing = await prisma.supportTicket.findUnique({
                where: { id: legacy.id }
            });

            if (existing) {
                skippedCount++;
                continue;
            }

            // 2. Find the user in Postgres by Telegram ID
            const user = await prisma.user.findUnique({
                where: { telegramId: BigInt(legacy.user_id) }
            });

            if (!user) {
                console.warn(`⚠️ User with Telegram ID ${legacy.user_id} not found in Postgres. Skipping ticket #${legacy.id}.`);
                skippedCount++;
                continue;
            }

            // 3. Map status
            let status = 'OPEN';
            if (legacy.status === 'in_progress') status = 'IN_PROGRESS';
            if (legacy.status === 'closed') status = 'CLOSED';

            // 4. Create the ticket
            try {
                // We use raw query if we want to force the ID on an autoincrement column in Postgres
                // Or we can just use prisma.create if we don't MIND new IDs, 
                // but for EXISTING buttons to work, we MUST use the same ID.
                await prisma.$executeRaw`
                    INSERT INTO "SupportTicket" (id, "userId", status, "isUrgent", "issueText", "topicId", "assignedAdminId", "createdAt", "updatedAt")
                    VALUES (${legacy.id}, ${user.id}, ${status}::"TicketStatus", ${Boolean(legacy.is_urgent)}, ${legacy.issue_text || ''}, ${legacy.topic_id}, ${legacy.assigned_admin_username ? String(legacy.assigned_admin_username) : null}, ${new Date(legacy.created_at)}, ${new Date(legacy.created_at)})
                `;
                migratedCount++;
            } catch (err) {
                console.error(`❌ Failed to migrate ticket #${legacy.id}:`, err);
                errorCount++;
            }
        }

        // 5. Update the sequence in Postgres so it doesn't conflict with manually inserted IDs
        const maxIdResult = await prisma.$queryRaw`SELECT MAX(id) FROM "SupportTicket"`;
        const maxId = (maxIdResult as any)[0].max;
        if (maxId) {
            await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"SupportTicket"', 'id'), ${maxId})`);
            console.log(`📈 Updated SupportTicket sequence to ${maxId}.`);
        }

        console.log("\n🎉 TICKETS MIGRATION COMPLETED!");
        console.log(`✅ Migrated: ${migratedCount}`);
        console.log(`⏭️ Skipped (already exist or no user): ${skippedCount}`);
        console.log(`❌ Errors: ${errorCount}`);

    } catch (e) {
        console.error("❌ Migration Failed:", e);
    } finally {
        await prisma.$disconnect();
        sqlite.close();
    }
}

migrateTickets();
