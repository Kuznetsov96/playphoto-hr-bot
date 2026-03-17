import type { BotCommand } from "grammy/types";
import type { MyContext } from "../types/context.js";
import type { AdminRole } from "@prisma/client";
import logger from "../core/logger.js";

/**
 * Command sets for different roles (Apple Style: Precise and Relevant)
 */
const COMMAND_SETS: Record<string, BotCommand[]> = {
    SUPER_ADMIN: [
        { command: "start", description: "🏠 Admin Panel" },
        { command: "hr", description: "🚀 HR Hub" },
        { command: "mentor", description: "🎓 Mentor Hub" },
    ],
    CO_FOUNDER: [
        { command: "start", description: "🏠 Admin Panel" },
    ],
    HR_LEAD: [
        { command: "start", description: "🚀 HR Hub" },
    ],
    MENTOR_LEAD: [
        { command: "start", description: "🎓 Mentor Hub" },
    ],
    STAFF: [
        { command: "start", description: "📸 Мій кабінет" },
        { command: "support", description: "🤍 Служба турботи" },
    ],
    CANDIDATE: [
        { command: "start", description: "⏳ Статус анкети" },
    ],
    DEFAULT: [
        { command: "start", description: "🏠 Головне меню" },
    ]
};

/**
 * Updates the command menu for a specific user based on their role
 */
export async function updateUserCommands(ctx: MyContext, role: string, adminRole?: AdminRole | null) {
    const userId = ctx.from?.id;
    if (!userId) return;

    let commands: BotCommand[] = COMMAND_SETS.DEFAULT || [];

    if (adminRole === "SUPER_ADMIN") {
        commands = COMMAND_SETS.SUPER_ADMIN || [];
    } else if (adminRole === "CO_FOUNDER") {
        commands = COMMAND_SETS.CO_FOUNDER || [];
    } else if (adminRole === "HR_LEAD") {
        commands = COMMAND_SETS.HR_LEAD || [];
    } else if (adminRole === "MENTOR_LEAD") {
        commands = COMMAND_SETS.MENTOR_LEAD || [];
    } else if (role === "STAFF") {
        commands = COMMAND_SETS.STAFF || [];
    } else if (role === "CANDIDATE") {
        commands = COMMAND_SETS.CANDIDATE || [];
    }

    try {
        await ctx.api.setMyCommands(commands, {
            scope: {
                type: "chat",
                chat_id: userId,
            },
        });
        logger.debug({ userId, role, adminRole }, "Updated user commands scope");
    } catch (error) {
        logger.error({ userId, error }, "Failed to update user commands scope");
    }
}
