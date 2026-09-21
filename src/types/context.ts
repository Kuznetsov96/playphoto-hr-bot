import type { Context, SessionFlavor } from "grammy";
import type { ConversationFlavor } from "@grammyjs/conversations";
import type { MenuFlavor } from "@grammyjs/menu";
import type { User, StaffProfile, Candidate, Location } from "@prisma/client";
import type { StaffWithRelations } from "../repositories/staff-repository.js";

export type CtxDbUser = User & {
    staffProfile: (StaffProfile & { location: Location | null }) | null;
    candidate: (Candidate & { location: Location | null }) | null;
};

// CI Trigger Comment
export type MenuId =
    | "admin-main" | "admin-team-ops" | "admin-finance" | "admin-system" | "admin-stats"
    | "mentor-hub-menu" | "candidate-root"
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

    /**
     * Пояснення, яке треба показати згори наступного екрана анкети —
     * наприклад, чому надіслане фото не підійшло. Живе один рендер:
     * startScreening читає його і одразу стирає.
     *
     * Потрібне, бо анкета тримається на одному повідомленні: окремий екран
     * помилки затирав саме питання разом з клавіатурою.
     */
    pendingScreeningNotice?: string;

    candidateData: {
        id?: string;
        fullName?: string;
        birthDate?: string;
        /** Проміжні частини дати народження між екранами вибору рік → місяць → день. */
        birthYear?: number;
        birthMonth?: number;
        /** Обране десятиріччя на екрані повного вибору року («Інший рік»). */
        birthDecade?: number;
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
        // Останній робочий день (`YYYY-MM-DD`) для тих, хто доопрацьовує.
        worksUntil?: string | null;
        /**
         * Дни подставлены из уже отправленной заявки, а не отмечены сейчас.
         * Календарь по этому флагу объясняет, откуда они взялись, — иначе
         * чужие на вид отметки читаются как сбой.
         */
        prefilled?: boolean;
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
        /**
         * `staff.user.telegramId` read at `startTaskFlow` (step 0), where the staff record —
         * with its `user` relation — is already in hand. Carrying it through the session means
         * `task_confirm_save` can notify the photographer without a second
         * `userRepository.findByStaffProfileId` lookup for data already fetched once.
         *
         * Stored as a string, not bigint: the session round-trips through Redis as JSON
         * (see core/session.ts `bigIntReplacer`), which turns a bigint into a string on the
         * way out but never converts it back on the way in — so a `bigint`-typed field here
         * would silently become a string on the very next request anyway. `null` means the
         * staff member has no linked Telegram account.
         */
        staffTelegramId?: string | null;
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
        /**
         * Сообщения бота, несущие кнопки «Готово»/«Скасувати». Их несколько:
         * приглашение и по одному на каждое принятое фото. Завершение гасит
         * клавиатуры во всех, иначе в чате остаются рабочие кнопки поверх уже
         * сданной посылки.
         */
        promptMessageIds?: number[];
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
        staffName?: string;
        taskText?: string;
        deadlineTime?: string | null;
        fileId?: string | null;
        mediaType?: TaskAttachmentItem["type"];
        sourceChatId?: number;
        sourceMessageId?: number;
        completionMode?: TaskCompletionModeValue;
        /**
         * Memo of the last `getTaskCreationStaff(locationId, date)` result, keyed on that
         * same (locationId, date) pair. Toggling one staff checkbox only changes
         * `selectedStaffIds` — the roster for that location/date hasn't moved — so re-fetching
         * it from the DB on every tap is wasted work. Keying on the pair means the memo is
         * used only while it's still describing the screen the admin is looking at; picking a
         * different location or date naturally misses the key and refetches.
         */
        staffOptionsCache?: {
            key: string;
            staff: StaffWithRelations[];
            source: "schedule" | "location";
        };
    };
    bulkTaskData?: {
        step?: "SELECT_DATE" | "SELECT_CITIES" | "SELECT_SCOPE" | "SELECT_LOCATIONS"
             | "SELECT_RECIPIENTS" | "SELECT_MODE" | "AWAITING_TEXT" | "SELECT_DEADLINE" | "CONFIRM" | "SENDING";
        date?: string;
        cities?: string[];
        locationIds?: string[];
        excludedStaffIds?: string[];
        completionMode?: TaskCompletionModeValue;
        taskText?: string;
        fileId?: string | null;
        mediaType?: TaskAttachmentItem["type"];
        deadlineTime?: string | null;
    };
    adminFlow?: 'SCHEDULE' | 'LOCATIONS' | 'SEARCH' | 'BROADCAST' | 'TASK' | 'BULK_TASK' | 'EXPENSE' | 'MANUAL_CHANNEL_ACCESS' | 'LOGISTICS' | 'MAGNET_COUNTER' | 'RECRUITMENT' | undefined;
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
    /** DB user loaded once per update (null = not registered, undefined = not loaded). */
    dbUser?: CtxDbUser | null;
};
