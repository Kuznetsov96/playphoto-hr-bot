import { CandidateStatus } from "@prisma/client";

export type OnboardingResumeAction = "resume_form" | "finish_onboarding" | "prompt_preferences";

export function canConfirmNDA(candidate: { status: CandidateStatus; ndaConfirmedAt: Date | null }): boolean {
    return candidate.status === CandidateStatus.NDA && candidate.ndaConfirmedAt === null;
}

export function getOnboardingResumeAction(
    candidateStatus: CandidateStatus,
    resumeStep: string,
    finalStep: string
): OnboardingResumeAction {
    if (resumeStep !== finalStep) return "resume_form";
    if (candidateStatus === CandidateStatus.READY_FOR_HIRE) return "finish_onboarding";
    return "prompt_preferences";
}
