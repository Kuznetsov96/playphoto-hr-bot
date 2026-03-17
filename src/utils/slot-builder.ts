import { InlineKeyboard } from "grammy";

export const createDatePickerKb = (prefix: string) => {
    const kb = new InlineKeyboard();
    const now = new Date();
    
    // Row 1: Today, Tomorrow
    kb.text("Today", `${prefix}_date_today`);
    kb.text("Tomorrow", `${prefix}_date_tomorrow`).row();

    // Row 2: Next 3 days
    for (let i = 2; i <= 4; i++) {
        const d = new Date();
        d.setDate(now.getDate() + i);
        const day = d.toLocaleDateString('en-US', { weekday: 'short' });
        const date = d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
        const label = `${day}, ${date}`;
        const dateStr = d.toISOString().split('T')[0];
        kb.text(label, `${prefix}_date_${dateStr}`);
    }
    kb.row();

    // Row 3: Days 5-7
    for (let i = 5; i <= 7; i++) {
        const d = new Date();
        d.setDate(now.getDate() + i);
        const day = d.toLocaleDateString('en-US', { weekday: 'short' });
        const date = d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
        const label = `${day}, ${date}`;
        const dateStr = d.toISOString().split('T')[0];
        kb.text(label, `${prefix}_date_${dateStr}`);
    }
    kb.row();

    kb.text("❌ Cancel", "cancel_step");
    return kb;
};

export const createTimePickerKb = (prefix: string) => {
    const kb = new InlineKeyboard();
    const hours = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    
    hours.forEach((h, i) => {
        const label = `${h}:00`;
        kb.text(label, `${prefix}_time_${h}`);
        if ((i + 1) % 4 === 0) kb.row();
    });

    kb.text("⬅️ Back to Dates", `${prefix}_back_dates`);
    return kb;
};

export const createDurationPickerKb = (prefix: string) => {
    return new InlineKeyboard()
        .text("📍 Just 1 Slot (20 min)", `${prefix}_dur_20`).row()
        .text("📅 Window: 2 hours", `${prefix}_dur_120`).row()
        .text("📅 Window: 4 hours", `${prefix}_dur_240`).row()
        .text("✍️ Custom...", `${prefix}_dur_custom`).row()
        .text("⬅️ Back to Time", `${prefix}_back_time`);
};
