import { InlineKeyboard } from "grammy";

function formatButtonTypeLabel(buttonType: string): string {
    const labels: Record<string, string> = {
        default: "Confirm / Decline",
        preferences: "Preferences",
        none: "No buttons"
    };

    return labels[buttonType] || buttonType;
}

function formatAudienceLabel(stats: { users: number, chats: number }): string {
    const parts: string[] = [];
    if (stats.users > 0) parts.push(`${stats.users} user${stats.users === 1 ? '' : 's'}`);
    if (stats.chats > 0) parts.push(`${stats.chats} chat${stats.chats === 1 ? '' : 's'}`);
    return parts.length > 0 ? parts.join(' and ') : 'No recipients';
}

export function formatTargetLabel(type: string): string {
    const labels: Record<string, string> = {
        'all': '🌐 All Teams Chats',
        'hub': '🏢 HUB Only',
        'city_chats': '🏘️ City Chats',
        'pm_all': '👤 PM: All Staff',
        'pm_city': '👤 PM: By Cities',
        'pm_location': '👤 PM: Specific Locations',
        'city_chat_location': '🏘️ Specific City Chats'
    };
    return labels[type] || type;
}

export function getBroadcastKb(confirmed: boolean, sent: boolean, stats: { users: number, chats: number }) {
    const kb = new InlineKeyboard();

    // Test button: Show "Send Test Again" if at least one test was sent OR if confirmed
    if (sent || confirmed) {
        kb.text("🧪 Send Test Again", "b_test").row();
    } else {
        kb.text("🧪 Send Test (to me)", "b_test").row();
    }

    const audience = formatAudienceLabel(stats);
    const sendLabel = confirmed ? `🔥 Send Broadcast (${audience})` : `✅ Send Broadcast (${audience})`;

    return kb.text(sendLabel, "b_send");
}

export function getBroadcastPreview(textHtml: string, targetType: string, stats: { users: number, chats: number }, confirmed: boolean, sent: boolean, buttonType: string = 'default', mediaSummary = '') {
    let status = confirmed ? "\n\n✅ <b>Test confirmed.</b> The broadcast is ready to send." : (sent ? "\n\n🧪 <b>Test message sent.</b> Review it in your PM before sending." : "\n\n📩 Send a test or launch the broadcast when everything looks correct.");
    const targetLabel = formatTargetLabel(targetType);
    const body = textHtml || "<i>No text caption</i>";
    return `📢 <b>Broadcast Preview</b>\n\n${body}${mediaSummary ? `\n\n${mediaSummary}` : ''}\n\n🎯 Target: <b>${targetLabel}</b>\n🔘 Buttons: <b>${formatButtonTypeLabel(buttonType)}</b>\n👥 Audience: <b>${formatAudienceLabel(stats)}</b>${status}`;
}
