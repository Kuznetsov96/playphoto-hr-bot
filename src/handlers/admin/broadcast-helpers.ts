import { InlineKeyboard } from "grammy";

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

    const statsStr = `${stats.users} u, ${stats.chats} c`;
    const sendLabel = confirmed ? `🔥 CONFIRMED: SEND (${statsStr})` : `✅ YES, SEND (${statsStr})`;

    return kb.text(sendLabel, "b_send");
}

export function getBroadcastPreview(textHtml: string, targetType: string, stats: { users: number, chats: number }, confirmed: boolean, sent: boolean, buttonType: string = 'default') {
    let status = confirmed ? "\n\n✅ <b>Test confirmed!</b> Ready to send." : (sent ? "\n\n🧪 <b>Test message sent!</b> Check PM." : "\n\n📩 Ready? Send test or broadcast.");
    const targetLabel = formatTargetLabel(targetType);
    return `📢 <b>PREVIEW:</b>\n\n${textHtml}\n\n🎯 Target: <b>${targetLabel}</b>\n🔘 Buttons: <b>${buttonType}</b>\n👥 Audience: <b>${stats.users} users, ${stats.chats} chats</b>${status}`;
}
