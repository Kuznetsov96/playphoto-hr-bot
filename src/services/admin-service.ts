
import { timelineRepository } from "../repositories/timeline-repository.js";
import { chatLogRepository } from "../repositories/chat-log-repository.js";
import { userRepository } from "../repositories/user-repository.js";
import { candidateRepository } from "../repositories/candidate-repository.js";


interface UnifiedEvent {
    createdAt: Date;
    source: 'timeline' | 'chat';
    icon: string;
    label: string;
    text: string | null;
    meta: string | null;
}

export const adminService = {
    async generateFullTimeline(userId: string): Promise<string> {
        const user = await userRepository.findWithStaffProfileById(userId);
        const candidate = await candidateRepository.findByUserId(userId);
        const [history, chatLogs] = await Promise.all([
            timelineRepository.getHistory(userId),
            chatLogRepository.getHistoryByUserId(userId, 10000, 0),
        ]);

        if (!user) return `User not found: ${userId}`;

        const userName = candidate?.fullName || user.staffProfile?.fullName || user.firstName || 'User';

        const lines: string[] = [];

        // Header
        lines.push(`========================================`);
        lines.push(`FULL USER REPORT`);
        lines.push(`Generated: ${new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}`);
        lines.push(`========================================`);
        lines.push(`User ID: ${user.id}`);
        lines.push(`Telegram ID: ${user.telegramId}`);
        lines.push(`Username: ${user.username ? '@' + user.username : 'N/A'}`);
        lines.push(`Name: ${user.firstName || 'N/A'} ${user.lastName || ''}`);

        if (candidate) {
            lines.push(`--- CANDIDATE PROFILE ---`);
            lines.push(`Full Name: ${candidate.fullName}`);
            lines.push(`City: ${candidate.city}`);
            lines.push(`Status: ${candidate.status}`);
            lines.push(`Source: ${candidate.source}`);
            lines.push(`Age: ${candidate.birthDate ? (new Date().getFullYear() - candidate.birthDate.getFullYear()) : 'N/A'}`);
        }

        if (user.staffProfile) {
            lines.push(`--- STAFF PROFILE ---`);
            lines.push(`Full Name: ${user.staffProfile.fullName}`);
            lines.push(`Role: ${user.role}`);
            lines.push(`Location: ${user.staffProfile.location?.name} (${user.staffProfile.location?.city})`);
        }

        // Merge timeline events and chat logs into a single chronological list
        const events: UnifiedEvent[] = [];

        for (const event of history) {
            let icon = '🔹';
            switch (event.type) {
                case 'MESSAGE': icon = event.author === 'USER' ? '👤' : '👮‍♂️'; break;
                case 'SYSTEM_EVENT': icon = '⚙️'; break;
                case 'STATUS_CHANGE': icon = '🔄'; break;
            }
            const authorStr = event.author === 'USER' ? userName : event.author;
            let meta: string | null = null;
            if (event.metadata) {
                try {
                    const m = JSON.parse(event.metadata);
                    meta = Object.entries(m).map(([k, v]) => `${k}: ${v}`).join(', ');
                } catch { meta = event.metadata; }
            }
            events.push({
                createdAt: event.createdAt,
                source: 'timeline',
                icon,
                label: `${event.type} | ${authorStr}`,
                text: event.text,
                meta,
            });
        }

        for (const log of chatLogs) {
            const dir = log.direction === 'IN' ? `👤 ${userName}` : '🤖 Bot';
            const typeTag = log.contentType !== 'text' ? ` [${log.contentType}]` : '';
            events.push({
                createdAt: log.createdAt,
                source: 'chat',
                icon: '',
                label: `${dir}${typeTag}`,
                text: log.text,
                meta: null,
            });
        }

        events.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        lines.push(`\n========================================`);
        lines.push(`FULL ACTIVITY LOG (${events.length} events)`);
        lines.push(`========================================\n`);

        for (const ev of events) {
            const dateStr = ev.createdAt.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
            lines.push(`[${dateStr}] ${ev.icon} ${ev.label}`);
            if (ev.text) {
                for (const l of ev.text.split('\n')) lines.push(`    ${l}`);
            }
            if (ev.meta) lines.push(`    [META: ${ev.meta}]`);
            lines.push(`----------------------------------------`);
        }

        return lines.join('\n');
    }
};
