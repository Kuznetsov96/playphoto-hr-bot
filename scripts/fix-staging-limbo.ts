import { PrismaClient, CandidateStatus, FunnelStep } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    console.log("🚀 Starting data fix for candidates in OFFLINE_STAGING...");

    const candidates = await prisma.candidate.findMany({
        where: {
            status: CandidateStatus.OFFLINE_STAGING,
            currentStep: FunnelStep.TRAINING
        }
    });

    console.log(`🔍 Found ${candidates.length} candidates in limbo state.`);

    for (const cand of candidates) {
        await prisma.candidate.update({
            where: { id: cand.id },
            data: { currentStep: FunnelStep.FIRST_SHIFT }
        });
        console.log(`✅ Fixed candidate: ${cand.fullName} (${cand.id})`);
    }

    console.log("✨ Done!");
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
