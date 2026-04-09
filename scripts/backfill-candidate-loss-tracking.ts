import { CandidateStatus, FunnelStep, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type Args = {
    apply: boolean;
};

function parseArgs(): Args {
    return {
        apply: process.argv.includes("--apply"),
    };
}

function deriveLossStage(candidate: {
    status: CandidateStatus;
    currentStep: FunnelStep;
    hrDecision: string | null;
    candidateDecision: string | null;
}): string {
    if (
        candidate.status === CandidateStatus.SCREENING ||
        candidate.status === CandidateStatus.MANUAL_REVIEW ||
        candidate.status === CandidateStatus.WAITLIST ||
        candidate.status === CandidateStatus.WAITLIST_HR ||
        candidate.status === CandidateStatus.WAITLIST_MENTOR
    ) {
        return candidate.currentStep === FunnelStep.INTERVIEW ? "INTERVIEW_BOOKING" : "SCREENING";
    }
    if (
        candidate.status === CandidateStatus.INTERVIEW_SCHEDULED ||
        candidate.status === CandidateStatus.INTERVIEW_COMPLETED ||
        candidate.status === CandidateStatus.DECISION_PENDING
    ) return "INTERVIEW";
    if (
        candidate.status === CandidateStatus.ACCEPTED ||
        candidate.status === CandidateStatus.DISCOVERY_SCHEDULED ||
        candidate.status === CandidateStatus.DISCOVERY_COMPLETED
    ) return "MENTOR_INTRO";
    if (
        candidate.status === CandidateStatus.TRAINING_SCHEDULED ||
        candidate.status === CandidateStatus.TRAINING_COMPLETED
    ) return "TRAINING";
    if (
        candidate.status === CandidateStatus.NDA ||
        candidate.status === CandidateStatus.KNOWLEDGE_TEST ||
        candidate.status === CandidateStatus.STAGING_SETUP ||
        candidate.status === CandidateStatus.STAGING_ACTIVE ||
        candidate.status === CandidateStatus.OFFLINE_STAGING ||
        candidate.status === CandidateStatus.READY_FOR_HIRE ||
        candidate.status === CandidateStatus.AWAITING_FIRST_SHIFT ||
        candidate.status === CandidateStatus.BLOCKER
    ) return "FINAL_PREP";
    if (candidate.status === CandidateStatus.HIRED) return "ONBOARDING";
    return "UNKNOWN";
}

function deriveLossReason(candidate: {
    hrDecision: string | null;
    candidateDecision: string | null;
    birthDate: Date | null;
    gender: string | null;
    city: string | null;
}) {
    if (candidate.hrDecision === "NOSHOW") return "INTERVIEW_NO_SHOW";
    if (candidate.hrDecision === "REJECTED_SYSTEM_UNDERAGE") return "UNDERAGE";
    if (candidate.hrDecision === "AGE_LIMIT") return "AGE_LIMIT";
    if (candidate.candidateDecision?.includes("Бот заблоковано")) return "BOT_BLOCKED";
    if (candidate.candidateDecision?.includes("відмовилась від участі")) return "CANDIDATE_WITHDREW";
    if (candidate.candidateDecision?.includes("не актуально")) return "CANDIDATE_DECLINED";
    if (candidate.candidateDecision?.includes("скасувала заявку")) return "CANDIDATE_CANCELLED";
    if (candidate.gender === "male") return "GENDER_MISMATCH";
    if (!candidate.birthDate) return "INCOMPLETE_PROFILE";
    if (!candidate.city) return "INCOMPLETE_PROFILE";
    return "REJECTED";
}

async function main() {
    const { apply } = parseArgs();
    const candidates = await prisma.candidate.findMany({
        where: {
            status: CandidateStatus.REJECTED,
            OR: [
                { lossStage: null },
                { lossReason: null },
                { lostAt: null },
            ]
        },
        select: {
            id: true,
            status: true,
            currentStep: true,
            hrDecision: true,
            candidateDecision: true,
            birthDate: true,
            gender: true,
            city: true,
            lossStage: true,
            lossReason: true,
            lostAt: true,
        }
    });

    const updates = candidates.map((candidate) => ({
        id: candidate.id,
        lossStage: candidate.lossStage || deriveLossStage(candidate),
        lossReason: candidate.lossReason || deriveLossReason(candidate),
        lostAt: candidate.lostAt || new Date(),
    }));

    console.log(`Found ${updates.length} rejected candidates to backfill.`);
    console.log(apply ? "Applying updates..." : "Dry run only. Use --apply to persist changes.");

    for (const update of updates.slice(0, 20)) {
        console.log(`• ${update.id} => ${update.lossStage} / ${update.lossReason}`);
    }
    if (updates.length > 20) {
        console.log(`• ... ${updates.length - 20} more`);
    }

    if (apply) {
        for (const update of updates) {
            await prisma.candidate.update({
                where: { id: update.id },
                data: {
                    lossStage: update.lossStage,
                    lossReason: update.lossReason,
                    lostAt: update.lostAt,
                }
            });
        }
        console.log("Backfill completed.");
    }
}

main()
    .catch((error) => {
        console.error(error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
