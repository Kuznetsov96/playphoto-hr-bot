import prisma from "../src/db/core.js";

type CandidateAuditRow = {
    id: string;
    fullName: string | null;
    username: string | null;
    city: string | null;
    status: string;
    hasUnreadMessage: boolean;
    hrMessageCount: number;
    lastHrUserMessageAt: Date | null;
    lastHrTeamMessageAt: Date | null;
};

async function main() {
    const candidates = await prisma.candidate.findMany({
        where: {
            gender: "male",
            OR: [
                { hasUnreadMessage: true },
                { messages: { some: { scope: "HR" } } }
            ]
        },
        include: {
            user: {
                select: {
                    telegramId: true,
                    username: true
                }
            },
            messages: {
                where: { scope: "HR" },
                orderBy: { createdAt: "desc" },
                select: {
                    id: true,
                    sender: true,
                    scope: true,
                    content: true,
                    createdAt: true
                }
            }
        },
        orderBy: [
            { hasUnreadMessage: "desc" },
            { updatedAt: "desc" }
        ]
    });

    const rows: CandidateAuditRow[] = candidates.map((candidate: any) => {
        const hrMessages = candidate.messages ?? [];
        const lastHrUserMessage = hrMessages.find((msg: any) => msg.sender === "USER") ?? null;
        const lastHrTeamMessage = hrMessages.find((msg: any) => msg.sender !== "USER") ?? null;

        return {
            id: candidate.id,
            fullName: candidate.fullName,
            username: candidate.user?.username ?? null,
            city: candidate.city,
            status: candidate.status,
            hasUnreadMessage: candidate.hasUnreadMessage,
            hrMessageCount: hrMessages.length,
            lastHrUserMessageAt: lastHrUserMessage?.createdAt ?? null,
            lastHrTeamMessageAt: lastHrTeamMessage?.createdAt ?? null
        };
    });

    console.log("=== MALE CANDIDATES WITH HR CONTACT SIGNALS ===");
    console.log(`Found: ${rows.length}`);

    if (rows.length === 0) {
        return;
    }

    for (const row of rows) {
        console.log("");
        console.log(`Candidate: ${row.fullName || "Unknown"} (${row.id})`);
        console.log(`Username: ${row.username ? `@${row.username}` : "—"}`);
        console.log(`City: ${row.city || "—"}`);
        console.log(`Status: ${row.status}`);
        console.log(`Unread flag: ${row.hasUnreadMessage ? "YES" : "no"}`);
        console.log(`HR messages: ${row.hrMessageCount}`);
        console.log(`Last USER -> HR: ${row.lastHrUserMessageAt?.toISOString() || "—"}`);
        console.log(`Last TEAM -> candidate: ${row.lastHrTeamMessageAt?.toISOString() || "—"}`);
    }

    const unreadOnly = rows.filter((row) => row.hasUnreadMessage);
    console.log("");
    console.log(`Candidates with hasUnreadMessage=true: ${unreadOnly.length}`);
    if (unreadOnly.length > 0) {
        console.log("IDs for manual review:");
        unreadOnly.forEach((row) => console.log(`- ${row.id} (${row.fullName || "Unknown"})`));
    }
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
