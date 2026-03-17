import Database from 'better-sqlite3';
import { PrismaClient } from '@prisma/client';
import path from 'path';
import fs from 'fs';

// Initialize Prisma Client for PostgreSQL (the destination)
// Ensure DATABASE_URL in .env points to Postgres
const prisma = new PrismaClient();

// Initialize SQLite (the source)
const sqlitePath = path.resolve(process.cwd(), 'db/hr_bot_backup.db');
if (!fs.existsSync(sqlitePath)) {
    console.error(`❌ SQLite database not found at ${sqlitePath}`);
    process.exit(1);
}
const sqlite = new Database(sqlitePath, { readonly: true });

async function migrate() {
    console.log("🚀 Starting migration from SQLite to PostgreSQL...");

    try {
        // --- 1. USERS ---
        console.log("Migrating Users...");
        const users = sqlite.prepare("SELECT * FROM User").all();
        for (const u of users) {
            const user: any = u;
            await prisma.user.upsert({
                where: { telegramId: BigInt(user.telegramId) },
                update: {},
                create: {
                    id: user.id,
                    telegramId: BigInt(user.telegramId),
                    username: user.username,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    role: user.role,
                    createdAt: new Date(user.createdAt),
                    updatedAt: new Date(user.updatedAt)
                }
            });
        }
        console.log(`✅ ${users.length} Users migrated.`);

        // --- 2. LOCATIONS ---
        console.log("Migrating Locations...");
        const locations = sqlite.prepare("SELECT * FROM Location").all();
        for (const l of locations) {
            const loc: any = l;
            await prisma.location.upsert({
                where: { id: loc.id },
                update: {},
                create: {
                    id: loc.id,
                    name: loc.name,
                    city: loc.city,
                    address: loc.address,
                    neededCount: loc.neededCount,
                    summaryTemplate: loc.summaryTemplate,
                    isHidden: Boolean(loc.isHidden),
                    googleMapsLink: loc.googleMapsLink,
                    salary: loc.salary,
                    schedule: loc.schedule,
                    legacyName: loc.legacyName,
                    sheet: loc.sheet,
                    terminalId: loc.terminalId,
                    searchId: loc.searchId,
                    hasAcquiring: Boolean(loc.hasAcquiring),
                    cashInEnvelope: Boolean(loc.cashInEnvelope),
                    fopId: loc.fopId
                }
            });
        }
        console.log(`✅ ${locations.length} Locations migrated.`);

        // --- 3. HR & MENTOR PROFILES ---
        console.log("Migrating HR Profiles...");
        const hrProfiles = sqlite.prepare("SELECT * FROM HRProfile").all();
        for (const p of hrProfiles) {
            const prof: any = p;
            await prisma.hRProfile.upsert({
                where: { id: prof.id },
                update: {},
                create: { id: prof.id, userId: prof.userId }
            });
        }
        console.log(`✅ ${hrProfiles.length} HR Profiles migrated.`);

        console.log("Migrating Mentor Profiles...");
        const mentorProfiles = sqlite.prepare("SELECT * FROM MentorProfile").all();
        for (const p of mentorProfiles) {
            const prof: any = p;
            await prisma.mentorProfile.upsert({
                where: { id: prof.id },
                update: {},
                create: { id: prof.id, userId: prof.userId }
            });
        }
        console.log(`✅ ${mentorProfiles.length} Mentor Profiles migrated.`);

        // --- 4. CANDIDATES (PARTIAL) ---
        console.log("Migrating Candidates (Phase 1: No Slots)...");
        const candidates = sqlite.prepare("SELECT * FROM Candidate").all();
        for (const c of candidates) {
            const cand: any = c;
            await prisma.candidate.upsert({
                where: { id: cand.id },
                update: {},
                create: {
                    id: cand.id,
                    userId: cand.userId,
                    fullName: cand.fullName,
                    birthDate: cand.birthDate ? new Date(cand.birthDate / 1) : null,
                    gender: cand.gender,
                    city: cand.city,
                    source: cand.source,
                    status: cand.status,
                    locationId: cand.locationId,
                    // Skip slots for now
                    interviewSlotId: undefined,
                    trainingSlotId: undefined,
                    googleMeetLink: cand.googleMeetLink,
                    trainingMeetLink: cand.trainingMeetLink,
                    currentStep: cand.currentStep,
                    isWaitlisted: Boolean(cand.isWaitlisted),
                    isHRLocked: Boolean(cand.isHRLocked),
                    isMentorLocked: Boolean(cand.isMentorLocked),
                    interviewCompletedAt: cand.interviewCompletedAt ? new Date(cand.interviewCompletedAt) : null,
                    trainingCompletedAt: cand.trainingCompletedAt ? new Date(cand.trainingCompletedAt) : null,
                    hrDecision: cand.hrDecision,
                    notificationSent: Boolean(cand.notificationSent),
                    candidateDecision: cand.candidateDecision,
                    hrScore: cand.hrScore,
                    mentorScore: cand.mentorScore,
                    hrComment: cand.hrComment,
                    mentorComment: cand.mentorComment,
                    appearance: cand.appearance,
                    hasUnreadMessage: Boolean(cand.hasUnreadMessage),
                    lastSystemMessageId: cand.lastSystemMessageId
                }
            });
        }
        console.log(`✅ ${candidates.length} Candidates inserted (partial).`);

        // --- 5. INTERVIEW SESSIONS & SLOTS ---
        console.log("Migrating Interview Sessions/Slots...");
        const intSessions = sqlite.prepare("SELECT * FROM InterviewSession").all();
        for (const s of intSessions) {
            const sess: any = s;
            await prisma.interviewSession.upsert({
                where: { id: sess.id },
                update: {},
                create: {
                    id: sess.id,
                    startTime: new Date(sess.startTime),
                    endTime: new Date(sess.endTime),
                    createdAt: new Date(sess.createdAt)
                }
            });
        }

        const intSlots = sqlite.prepare("SELECT * FROM InterviewSlot").all();
        for (const s of intSlots) {
            const slot: any = s;
            await prisma.interviewSlot.upsert({
                where: { id: slot.id },
                update: {},
                create: {
                    id: slot.id,
                    sessionId: slot.sessionId,
                    startTime: new Date(slot.startTime),
                    endTime: new Date(slot.endTime),
                    isBooked: Boolean(slot.isBooked),
                    googleEventId: slot.googleEventId,
                    reminded6h: Boolean(slot.reminded6h),
                    reminded10m: Boolean(slot.reminded10m),
                    reminded2mHR: Boolean(slot.reminded2mHR),
                    candidateId: slot.candidateId || null, // Can link now since Candidate exists
                    lastReminderMsgId: slot.lastReminderMsgId
                }
            });
        }
        console.log(`✅ ${intSlots.length} Interview Slots migrated.`);



        // --- 6. UPDATE CANDIDATES (LINK SLOTS) ---
        console.log("Updating Candidates with Slot Links...");
        for (const c of candidates) {
            const cand: any = c;
            if (cand.interviewSlotId || cand.trainingSlotId) {
                await prisma.candidate.update({
                    where: { id: cand.id },
                    data: {
                        interviewSlotId: cand.interviewSlotId || null,
                        trainingSlotId: cand.trainingSlotId || null
                    }
                });
            }
        }
        console.log("✅ Candidates updated.");



        // --- 9. FINAL SUCCESS ---
        console.log("\n🎉 DATA MIGRATION COMPLETED SUCCESSFULLY!");

    } catch (e) {
        console.error("❌ Migration Failed:", e);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
        sqlite.close();
    }
}

migrate();
