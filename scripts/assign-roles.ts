import { PrismaClient } from '@prisma/client';
import { ROLE_IDS } from '../src/config/roles.js';

const prisma = new PrismaClient();

async function assignInitialRoles() {
    console.log('🔧 Assigning initial admin roles...');

    const roleAssignments = [
        { telegramId: ROLE_IDS.SUPER_ADMIN, role: 'SUPER_ADMIN', name: 'Super Admin' },
        { telegramId: ROLE_IDS.CO_FOUNDER, role: 'CO_FOUNDER', name: 'Co-Founder' },
        { telegramId: ROLE_IDS.SUPPORT, role: 'SUPPORT', name: 'Support' },
        { telegramId: ROLE_IDS.HR_LEAD, role: 'HR_LEAD', name: 'HR Lead' },
        { telegramId: ROLE_IDS.MENTOR_LEAD, role: 'MENTOR_LEAD', name: 'Mentor Lead' },
    ];

    for (const { telegramId, role, name } of roleAssignments) {
        const user = await prisma.user.findUnique({
            where: { telegramId }
        });

        if (user) {
            await prisma.user.update({
                where: { id: user.id },
                data: { adminRole: role as any }
            });
            console.log(`✅ Assigned ${role} to ${name} (${telegramId})`);
        } else {
            console.log(`⚠️  User not found: ${name} (${telegramId})`);
        }
    }

    console.log('✅ Role assignment complete!');
}

assignInitialRoles()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
