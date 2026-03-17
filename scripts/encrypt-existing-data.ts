import { PrismaClient } from '@prisma/client';
import { cryptoUtility } from '../src/core/crypto.js';

const prisma = new PrismaClient();

async function runMigration() {
    console.log("🔒 Starting deep data encryption migration...");
    
    const encryptConfig: Record<string, string[]> = {
      Candidate: ['iban', 'passportNumber', 'ipn', 'bankCard', 'registrationAddress', 'passportPhotoIds'],
      ChatLog: ['text'],
      Message: ['content'],
      UserTimelineEvent: ['text', 'metadata'],
      Task: ['taskText'],
      SupportTicket: ['issueText']
    };

    for (const [model, fields] of Object.entries(encryptConfig)) {
        console.log(`Processing model: ${model}...`);
        const records = await (prisma as any)[model.toLowerCase()].findMany();
        
        let updatedCount = 0;
        for (const record of records) {
            const updateData: any = {};
            for (const field of fields) {
                const value = record[field];
                if (value && typeof value === 'string' && !value.startsWith('gcm:')) {
                    updateData[field] = cryptoUtility.encrypt(value);
                }
            }

            if (Object.keys(updateData).length > 0) {
                await (prisma as any)[model.toLowerCase()].update({
                    where: { id: record.id },
                    data: updateData
                });
                updatedCount++;
            }
        }
        console.log(`✅ ${model}: Encrypted ${updatedCount} records.`);
    }

    console.log("\n🏆 Deep encryption migration complete.");
    await prisma.$disconnect();
}

runMigration().catch(e => {
    console.error("❌ Migration failed:", e);
    process.exit(1);
});
