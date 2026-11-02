import { ADMIN_TEXTS } from "../constants/admin-texts.js";
import { escapeHtml } from "../handlers/admin/utils.js";
import { surnameAndName } from "./person-name.js";

/**
 * Candidate's message as the owner sees it in a private chat. The candidate's own
 * text is quoted as written; everything around it is the canonical owner format.
 */
export function renderCandidateMessageForAdmin(input: {
    fullName: string | null | undefined;
    username: string | null | undefined;
    city: string | null | undefined;
    stage: string;
    status?: string;
    recovery?: boolean;
    text: string;
}): string {
    return ADMIN_TEXTS["admin-notif-candidate-message"]({
        name: escapeHtml(surnameAndName(input.fullName || "Candidate")),
        username: escapeHtml(input.username || "no_user"),
        city: escapeHtml(input.city || "—"),
        stage: escapeHtml(input.stage),
        ...(input.status ? { status: escapeHtml(input.status) } : {}),
        ...(input.recovery ? { recovery: true } : {}),
        text: escapeHtml(input.text),
    });
}
