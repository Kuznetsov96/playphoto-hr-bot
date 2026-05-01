import { Bot } from "grammy";
import { PrismaClient } from "@prisma/client";
import { BOT_TOKEN } from "../config.js";

const prisma = new PrismaClient();

type Args = {
    candidateId?: string;
    telegramId?: bigint;
    firstShiftDate?: Date;
    firstShiftTime?: string;
    execute: boolean;
};

function parseArgs(argv: string[]): Args {
    const args: Args = { execute: false };

    for (let i = 0; i < argv.length; i++) {
        const part = argv[i];
        if (part === "--candidate-id") args.candidateId = argv[++i];
        else if (part === "--telegram-id") args.telegramId = BigInt(argv[++i] || "");
        else if (part === "--first-shift-date") {
            const raw = argv[++i];
            if (!raw) throw new Error("--first-shift-date requires YYYY-MM-DD");
            args.firstShiftDate = new Date(`${raw}T00:00:00.000Z`);
            if (Number.isNaN(args.firstShiftDate.getTime())) throw new Error(`Invalid date: ${raw}`);
        } else if (part === "--first-shift-time") args.firstShiftTime = argv[++i];
        else if (part === "--execute") args.execute = true;
    }

    if (!args.candidateId && !args.telegramId) {
        throw new Error("Provide --candidate-id <id> or --telegram-id <id>");
    }

    return args;
}

function stringify(value: unknown) {
    return JSON.stringify(value, (_key, nested) => typeof nested === "bigint" ? nested.toString() : nested, 2);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    const candidate = await prisma.candidate.findFirst({
        where: args.candidateId
            ? { id: args.candidateId }
            : { user: { telegramId: args.telegramId! } },
        include: {
            user: true,
            location: true,
            firstShiftOnboardingCase: {
                include: {
                    steps: { orderBy: { order: "asc" } },
                },
            },
        },
    });

    if (!candidate) {
        throw new Error("Candidate not found");
    }

    console.log("Candidate:");
    console.log(stringify({
        id: candidate.id,
        fullName: candidate.fullName,
        telegramId: candidate.user.telegramId,
        status: candidate.status,
        location: candidate.location?.name || candidate.city,
        firstShiftDate: candidate.firstShiftDate,
        firstShiftTime: candidate.firstShiftTime,
        onboardingCase: candidate.firstShiftOnboardingCase
            ? {
                id: candidate.firstShiftOnboardingCase.id,
                status: candidate.firstShiftOnboardingCase.status,
                topicId: candidate.firstShiftOnboardingCase.topicId,
                chatId: candidate.firstShiftOnboardingCase.chatId,
                currentStepKey: candidate.firstShiftOnboardingCase.currentStepKey,
                startedAt: candidate.firstShiftOnboardingCase.startedAt,
                steps: candidate.firstShiftOnboardingCase.steps.map(step => ({
                    key: step.key,
                    status: step.status,
                    submittedAt: step.submittedAt,
                })),
            }
            : null,
    }));

    if (!args.execute) {
        console.log("\nDry run only. Re-run with --execute to apply changes.");
        return;
    }

    if (candidate.firstShiftOnboardingCase?.topicId && candidate.firstShiftOnboardingCase.chatId) {
        try {
            const bot = new Bot(BOT_TOKEN);
            await bot.api.closeForumTopic(Number(candidate.firstShiftOnboardingCase.chatId), candidate.firstShiftOnboardingCase.topicId);
            console.log(`Closed forum topic ${candidate.firstShiftOnboardingCase.topicId}.`);
        } catch (err) {
            console.warn("Failed to close forum topic automatically. Continue with DB reset.");
            console.warn(err);
        }
    }

    if (candidate.firstShiftOnboardingCase) {
        await prisma.firstShiftOnboardingCase.delete({
            where: { candidateId: candidate.id },
        });
        console.log(`Deleted first-shift onboarding case ${candidate.firstShiftOnboardingCase.id}.`);
    }

    if (args.firstShiftDate || args.firstShiftTime) {
        await prisma.candidate.update({
            where: { id: candidate.id },
            data: {
                ...(args.firstShiftDate ? { firstShiftDate: args.firstShiftDate } : {}),
                ...(args.firstShiftTime ? { firstShiftTime: args.firstShiftTime } : {}),
            },
        });
        console.log("Updated first shift schedule.");
    }

    console.log("Reset completed.");
}

main()
    .catch(err => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
