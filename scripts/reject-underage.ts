import { PrismaClient, CandidateStatus } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    const today = new Date();
    const thresholdDate = new Date(today.getFullYear() - 17, today.getMonth(), today.getDate());

    console.log(`Rejecting candidates born after ${thresholdDate.toLocaleDateString()}...`);

    const underageCandidates = await prisma.candidate.findMany({
        where: {
            birthDate: {
                gt: thresholdDate,
            },
            status: {
                not: CandidateStatus.REJECTED,
            },
        },
    });

    console.log(`Found ${underageCandidates.length} underage candidates.`);

    for (const cand of underageCandidates) {
        console.log(`Rejecting ${cand.fullName} (born ${cand.birthDate?.toLocaleDateString()})...`);
        await prisma.candidate.update({
            where: { id: cand.id },
            data: {
                status: CandidateStatus.REJECTED,
                hrDecision: "REJECTED_SYSTEM_UNDERAGE",
                candidateDecision: "Вік менше 17 років",
                isWaitlisted: false,
            },
        });
    }

    console.log("Cleanup complete.");
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
