import { CandidateStatus, FunnelStep, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const REQUIRED_STEP_BY_STATUS = new Map<CandidateStatus, FunnelStep>([
    [CandidateStatus.INTERVIEW_SCHEDULED, FunnelStep.INTERVIEW],
    [CandidateStatus.INTERVIEW_COMPLETED, FunnelStep.INTERVIEW],
    [CandidateStatus.DECISION_PENDING, FunnelStep.INTERVIEW],
    [CandidateStatus.ACCEPTED, FunnelStep.TRAINING],
    [CandidateStatus.WAITLIST_MENTOR, FunnelStep.TRAINING],
    [CandidateStatus.DISCOVERY_SCHEDULED, FunnelStep.TRAINING],
    [CandidateStatus.DISCOVERY_COMPLETED, FunnelStep.TRAINING],
    [CandidateStatus.TRAINING_SCHEDULED, FunnelStep.TRAINING],
    [CandidateStatus.TRAINING_COMPLETED, FunnelStep.TRAINING],
    [CandidateStatus.NDA, FunnelStep.TRAINING],
    [CandidateStatus.KNOWLEDGE_TEST, FunnelStep.TRAINING],
    [CandidateStatus.STAGING_SETUP, FunnelStep.FIRST_SHIFT],
    [CandidateStatus.STAGING_ACTIVE, FunnelStep.FIRST_SHIFT],
    [CandidateStatus.OFFLINE_STAGING, FunnelStep.FIRST_SHIFT],
    [CandidateStatus.READY_FOR_HIRE, FunnelStep.FIRST_SHIFT],
    [CandidateStatus.AWAITING_FIRST_SHIFT, FunnelStep.FIRST_SHIFT],
    [CandidateStatus.HIRED, FunnelStep.FIRST_SHIFT],
]);

async function main() {
    const shouldApply = process.argv.includes("--apply");

    const candidates = await prisma.candidate.findMany({
        where: {
            status: { in: Array.from(REQUIRED_STEP_BY_STATUS.keys()) },
        },
        select: {
            id: true,
            fullName: true,
            status: true,
            currentStep: true,
            interviewSlotId: true,
            discoverySlotId: true,
            trainingSlotId: true,
            hrDecision: true,
            statusChangedAt: true,
        },
        orderBy: { statusChangedAt: "desc" },
    });

    const mismatches = candidates
        .map((candidate) => {
            const expectedStep = REQUIRED_STEP_BY_STATUS.get(candidate.status);
            if (!expectedStep || candidate.currentStep === expectedStep) return null;
            return { ...candidate, expectedStep };
        })
        .filter(Boolean) as Array<{
        id: string;
        fullName: string | null;
        status: CandidateStatus;
        currentStep: FunnelStep;
        expectedStep: FunnelStep;
        interviewSlotId: string | null;
        discoverySlotId: string | null;
        trainingSlotId: string | null;
        hrDecision: string | null;
        statusChangedAt: Date | null;
    }>;

    console.log(`Scanned ${candidates.length} candidates in guarded funnel states.`);
    console.log(`Found ${mismatches.length} status/currentStep mismatches.`);

    if (mismatches.length === 0) return;

    for (const mismatch of mismatches) {
        console.log([
            mismatch.id,
            mismatch.fullName ?? "Unknown",
            `status=${mismatch.status}`,
            `currentStep=${mismatch.currentStep}`,
            `expectedStep=${mismatch.expectedStep}`,
            `interviewSlotId=${mismatch.interviewSlotId ?? "-"}`,
            `discoverySlotId=${mismatch.discoverySlotId ?? "-"}`,
            `trainingSlotId=${mismatch.trainingSlotId ?? "-"}`,
            `hrDecision=${mismatch.hrDecision ?? "-"}`,
        ].join(" | "));
    }

    if (!shouldApply) {
        console.log("Dry run only. Re-run with --apply to fix the mismatches above.");
        return;
    }

    for (const mismatch of mismatches) {
        await prisma.candidate.update({
            where: { id: mismatch.id },
            data: { currentStep: mismatch.expectedStep },
        });
    }

    console.log(`Applied ${mismatches.length} currentStep corrections.`);
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
