import type { Context, SessionFlavor } from "grammy";
import type { ConversationFlavor } from "@grammyjs/conversations";
import type { MenuFlavor } from "@grammyjs/menu";

// CI Trigger Comment
export type MenuId =
    | "admin-main" | "admin-team-ops" | "admin-ops" | "admin-finance" | "admin-system" | "admin-stats"
    | "hr-hub-menu" | "hr-dashboard-dates" | "mentor-hub-menu" | "candidate-root"
    | string;

export interface StackEntry {
    menuId: MenuId;
    state?: Partial<SessionData>; // Snapshot of session data for this screen
}

export interface BroadcastMediaItem {
    type: 'photo' | 'video' | 'document' | 'voice' | 'video_note' | 'audio' | 'animation';
    fileId: string;
}

export interface TaskAttachmentItem {
    type: 'photo' | 'video' | 'document' | 'voice' | 'video_note' | 'audio' | 'animation';
    fileId: string;
}

export type TaskCompletionModeValue = 'QUICK' | 'PROOF_REQUIRED';

export interface SessionData {
    step: string;
    navStack: StackEntry[]; // Smart navigation history with state preservation
    messagesToDelete: number[]; // Initialized as array via middleware/session default

    candidateData: {
        id?: string;
        fullName?: string;
        birthDate?: string;
        gender?: string;
        age?: number;
        city?: string;
        locationId?: string;
        /** ⚠️ ALWAYS use as array. Use getLocationIds() helper to safely read */
        locationIds?: string[];
        source?: string;
        clickSource?: string;
        appearance?: string;
        tattooPhotoId?: string;
        step?: string;
        trainingScore?: number;
        phone?: string;
        email?: string;
        iban?: string;
        instagram?: string;
        passportPhotoIds?: string[];
    };

    preferencesData?: {
        step: string;
        month?: string; // Localized month name
        year?: number;
        selectedDays?: number[];
        comment?: string;
        forceNextMonth?: boolean;
        forceEdit?: boolean;
    };

    slotBuilder?: {
        date: string;
        startHour?: number;
        startMinute?: number;
        duration?: number;
        mode?: 'calendar' | 'candidate';
        candidateId?: string;
    };

    taskData?: {
        step: string;
        staffId?: string;
        staffName?: string;
        city?: string;
        locationName?: string;
        workDate?: string;
        deadlineTime?: string | null;
        completionMode?: TaskCompletionModeValue;
        text?: string;
        fileId?: string | null;
        mediaType?: TaskAttachmentItem["type"];
        sourceChatId?: number;
        sourceMessageId?: number;
        menuMessageId?: number;
    };

    broadcastData?: {
        step: string;
        targetType: string;
        targetValue: any;
        buttonType: string;
        text?: string;
        media?: BroadcastMediaItem;
        mediaItems?: BroadcastMediaItem[];
        selectedLocs: string[];
        menuMessageId?: number;
    };

    supportData?: {
        step?: string;
        replyingToUserId?: string;
        ticketFilter?: string;
        preferredTarget?: "HR" | "MENTOR" | "RECOVERY";
        entryReason?: "RETURNED_AFTER_BOT_BLOCK";
        magnetCount?: {
            recordId?: string;
            estimateTotal?: number;
            confidence?: "high" | "medium" | "low";
            stackCounts?: number[];
            notes?: string;
            correctedTotal?: number;
            analyzedPhotoFileId?: string;
        };
    };

    parcelPhotoDraft?: {
        parcelId: string;
        fileIds: string[];
        startedAt: number;
        lastPhotoAt?: number;
    };
    parcelPhotoCancelledDraft?: {
        parcelId: string;
        cancelledAt: number;
    };

    taskProofFlow?: {
        taskId: string;
        replySubmissionId?: string;
    };

    // Legacy / Other module fields
    lastMenuMessageId?: number;
    staffSeenWelcome?: boolean;
    activeTasksCount?: number;
    clarificationTaskId?: string;
    ticketId?: number; // Must be number based on existing repository
    selectedCandidateId?: string | undefined;
    selectedSlotId?: string;
    selectedDate?: string;
    selectedTrainingDate?: string;
    selectedLocationId?: string;
    selectedUserId?: string;
    selectedUserIdForAdmin?: string;
    candidateProfileMenuId?: "hr-candidate-unified" | "admin-candidate-details";
    stagingTime?: string;
    stagingLocationId?: string;
    lastConfirmedAt?: number;
    pendingMessage?: any;
    hrBackNav?: string;
    filterWaitlist?: boolean;
    candidatePage?: number;
    hiringNeedsPage?: number;
    manualPage?: number;
    selectedNoSlotReason?: string | null;
    broadcastValue?: string | string[];
    broadcastCity?: string;
    broadcastLocationId?: string;
    broadcastLocationName?: string;
    statsView?: "overview" | "losses";
    broadcastDraft?: any;
    broadcastTestConfirmed?: boolean;
    customSyncPromptMessageId?: number;
    taskCreation?: {
        step?: string;
        date?: string;
        city?: string;
        locationId?: string;
        locationName?: string;
        selectedStaffIds?: string[];
        staffId?: string;
        staffName?: string;
        taskText?: string;
        deadlineTime?: string | null;
        fileId?: string | null;
        mediaType?: TaskAttachmentItem["type"];
        sourceChatId?: number;
        sourceMessageId?: number;
        completionMode?: TaskCompletionModeValue;
    };
    adminFlow?: 'SCHEDULE' | 'LOCATIONS' | 'SEARCH' | 'BROADCAST' | 'TASK' | undefined;
    viewingFromInbox?: boolean;
    broadcastId?: number;
    teamSyncPreview?: {
        token: string;
        generatedAt: number;
        requiresConfirmation: boolean;
    };
    manualChannelAccess?: {
        step: "AWAITING_GRANT_DETAILS" | "AWAITING_REVOKE_ID";
    };
}

export type MyContext = Context & SessionFlavor<SessionData> & ConversationFlavor<Context & SessionFlavor<SessionData>> & MenuFlavor & {
    di: any;
    correlationId?: string;
};
