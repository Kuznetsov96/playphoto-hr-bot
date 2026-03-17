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
    };

    slotBuilder?: {
        date: string;
        startHour?: number;
        startMinute?: number;
        duration?: number;
    };

    taskData?: {
        step: string;
        staffId?: string;
        staffName?: string;
        city?: string;
        locationName?: string;
        workDate?: string;
        deadlineTime?: string | null;
        text?: string;
        menuMessageId?: number;
    };

    broadcastData?: {
        step: string;
        targetType: string;
        targetValue: any;
        buttonType: string;
        text?: string;
        media?: { type: 'photo' | 'video', fileId: string };
        selectedLocs: string[];
        menuMessageId?: number;
    };

    supportData?: {
        step?: string;
        replyingToUserId?: string;
        ticketFilter?: string;
    };

    // Legacy / Other module fields
    lastMenuMessageId?: number;
    staffSeenWelcome?: boolean;
    activeTasksCount?: number;
    clarificationTaskId?: string;
    ticketId?: number; // Must be number based on existing repository
    selectedCandidateId?: string;
    selectedSlotId?: string;
    selectedDate?: string;
    selectedTrainingDate?: string;
    selectedOnboardingDate?: string;
    selectedLocationId?: string;
    selectedUserId?: string;
    selectedUserIdForAdmin?: string;
    stagingTime?: string;
    stagingLocationId?: string;
    lastConfirmedAt?: number;
    pendingMessage?: any;
    hrBackNav?: string;
    filterWaitlist?: boolean;
    candidatePage?: number;
    broadcastValue?: string | string[];
    broadcastCity?: string;
    broadcastLocationId?: string;
    broadcastLocationName?: string;
    broadcastDraft?: any;
    broadcastTestConfirmed?: boolean;
    taskCreation?: any;
    adminFlow?: 'SCHEDULE' | 'LOCATIONS' | 'SEARCH' | 'BROADCAST' | 'TASK';
    viewingFromInbox?: boolean;
}

export type MyContext = Context & SessionFlavor<SessionData> & ConversationFlavor<Context & SessionFlavor<SessionData>> & MenuFlavor & {
    di: any;
};
