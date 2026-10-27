/** Снимок рассылки для вебаппа — зеркало AnnouncementSnapshotDto (apps/api/src/announcements/dto). */
export type SnapshotDeliveryStatus = "PENDING" | "SENDING" | "SENT" | "FAILED" | "SKIPPED";
export type SnapshotReplyStatus = "PENDING" | "CONFIRMED" | "DECLINED" | "DROPPED";

export interface AnnouncementRecipient {
    telegramId: string;
    displayName: string;
    deliveryStatus?: SnapshotDeliveryStatus;
    deliveredAt?: string;
    deliveryError?: string;
    replyStatus?: SnapshotReplyStatus;
    respondedAt?: string;
    declineReason?: string;
    supportTopicUrl?: string;
}

export interface AnnouncementChat {
    chatId: string;
    title?: string;
    deliveryStatus: SnapshotDeliveryStatus;
    deliveredAt?: string;
}

export interface AnnouncementActivity {
    at: string;
    kind: string;
    count?: number;
    actorName?: string;
}

export interface AnnouncementSnapshot {
    snapshotAt: string;
    botBroadcastId: number;
    source: "BOT" | "WEBAPP";
    authorTelegramId?: string;
    authorName?: string;
    messageHtml?: string;
    targetSummary?: string;
    replyMode: "CONFIRM" | "NONE" | "PREFERENCES";
    attachmentKinds: string[];
    createdAt: string;
    completedAt?: string;
    cancelledAt?: string;
    withdrawnAt?: string;
    withdrawnByName?: string;
    remindersStoppedAt?: string;
    remindersStoppedByName?: string;
    /** Текст ушёл подписью к вложению. */
    textAsCaption?: boolean;
    /** publicId выполненных действий вебаппа (последние 50). */
    actionsDone?: string[];
    nextReminderAt?: string;
    reminderUntil?: string;
    recipients: AnnouncementRecipient[];
    chats: AnnouncementChat[];
    activity: AnnouncementActivity[];
}
