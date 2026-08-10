import * as dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

// 1. Define Zod Schema for Environment Variables
const envSchema = z.object({
    // Core
    BOT_TOKEN: z.string().min(1, "BOT_TOKEN is missing"),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    BUSINESS_DATA_SOURCE: z.enum(["google", "aws"]).default("google"),
    AWS_BUSINESS_API_URL: z.string().url().optional(),
    AWS_BUSINESS_API_TOKEN: z.string().min(32).optional(),
    AWS_BUSINESS_SYNC_INTERVAL_MS: z.coerce.number().int().min(60_000).default(300_000),
    AWS_BUSINESS_MIN_EMPLOYEES: z.coerce.number().int().min(1).default(50),
    AWS_BUSINESS_MIN_LOCATIONS: z.coerce.number().int().min(1).default(19),
    AWS_SCHEDULE_SHADOW_READ_ENABLED: z.enum(["true", "false"]).default("false"),
    AWS_SCHEDULE_CANONICAL_READ_ENABLED: z.enum(["true", "false"]).default("false"),
    AWS_SCHEDULE_NOTIFICATIONS_ENABLED: z.enum(["true", "false"]).default("false"),
    AWS_REPLACEMENTS_SHADOW_ENABLED: z.enum(["true", "false"]).default("false"),
    AWS_REPLACEMENTS_CANONICAL_ENABLED: z.enum(["true", "false"]).default("false"),
    AWS_REMINDERS_CANONICAL_READ_ENABLED: z.enum(["true", "false"]).default("false"),
    AWS_PREFERENCES_CANONICAL_WRITE_ENABLED: z.enum(["true", "false"]).default("false"),

    // Staff Ids (Comma-separated integers)
    ADMIN_IDS: z.string().default(""),
    CO_FOUNDER_IDS: z.string().default(""),
    SUPPORT_IDS: z.string().default(""),
    MENTOR_IDS: z.string().default(""),
    HR_IDS: z.string().default(""),
    HR_NAME: z.string().default("HR"),
    MENTOR_NAME: z.string().default("наставник"),
    FINANCE_IDS: z.string().default(""),

    // Google / Sheets
    GOOGLE_CALENDAR_ID: z.string().optional(),
    TRAINING_CALENDAR_ID: z.string().optional(),
    MEET_LINK_HIRING: z.string().optional(),
    MEET_LINK_TRAINING: z.string().optional(),

    // Important Links
    NDA_LINK: z.string().optional(),
    KNOWLEDGE_BASE_LINK: z.string().optional(),
    PHOTOGRAPHER_GUIDE_LINK: z.string().optional(),

    // Spreadsheets (Required for full functionality)
    SPREADSHEET_ID_TECH_CASH: z.string().min(1, "TECH_CASH spreadsheet ID is missing"),
    SPREADSHEET_ID_DDS: z.string().min(1, "DDS spreadsheet ID is missing"),
    SPREADSHEET_ID_SCHEDULE: z.string().min(1, "SCHEDULE spreadsheet ID is missing"),
    SPREADSHEET_ID_TEAM: z.string().min(1, "TEAM spreadsheet ID is missing"),

    // Monobank
    MONO_TOKEN_KUZNETSOV: z.string().optional(),
    MONO_TOKEN_POSREDNIKOVA: z.string().optional(),
    MONO_TOKEN_KARPUK: z.string().optional(),
    MONO_TOKEN_GUPALOVA: z.string().optional(),

    // Nova Poshta
    NOVA_POSHTA_API_KEY: z.string().optional(),
    NP_RECIPIENT_PHONE: z.string().optional(),

    // OLX API
    OLX_CLIENT_ID: z.string().optional(),
    OLX_CLIENT_SECRET: z.string().optional(),
    OLX_REDIRECT_URI: z.string().default("https://playphoto-bot.com/olx/callback"),

    // Instagram Webhooks
    INSTAGRAM_VERIFY_TOKEN: z.string().default("playphoto_secret_v1"),

    // Security
    APP_ENCRYPTION_KEY: z.string().min(32, "APP_ENCRYPTION_KEY must be at least 32 characters for AES-256").optional(),
    BACKUP_PASSPHRASE: z.string().optional(),
    ALLOW_DEV_COMMANDS: z.enum(["true", "false"]).default("false"),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_VISION_MODEL: z.string().optional(),

    // Chats
    SUPPORT_CHAT_ID: z.string().min(1, "SUPPORT_CHAT_ID is missing"),
    RECOVERY_CHAT_ID: z.string().default("-1003873088973"),
    FIRST_SHIFT_ONBOARDING_CHAT_ID: z.string().optional(),
    LEADS_CHAT_ID: z.string().optional(),
    TEAM_HUB_CHAT_ID: z.string().min(1, "TEAM_HUB_CHAT_ID is missing"),
    TEAM_CHANNEL_ID: z.string().min(1, "TEAM_CHANNEL_ID is missing"),
    LOGISTICS_TOPIC_ID: z.string().optional(),

    // IBANs (Comma-separated)
    IBAN_KUZNETSOV: z.string().optional(),
    IBAN_KARPUK: z.string().optional(),
    IBAN_GUPALOVA: z.string().optional(),
    IBAN_POSREDNIKOVA: z.string().optional(),
    IBAN_EXCLUDED: z.string().optional()
});

// 2. Parse and Validate
const result = envSchema.safeParse(process.env);

if (!result.success) {
    console.error("❌ [CONFIG] Invalid Environment Variables:");
    console.error(JSON.stringify(result.error.format(), null, 4));
    process.exit(1);
}

const env = result.data;

if (env.BUSINESS_DATA_SOURCE === "aws" && (!env.AWS_BUSINESS_API_URL || !env.AWS_BUSINESS_API_TOKEN)) {
    console.error("❌ [CONFIG] AWS_BUSINESS_API_URL and AWS_BUSINESS_API_TOKEN are required in AWS business mode");
    process.exit(1);
}

// 3. Export Constants (Transformation Logic)
export const BOT_TOKEN = env.BOT_TOKEN;
export const BUSINESS_DATA_SOURCE = env.BUSINESS_DATA_SOURCE;
export const AWS_BUSINESS_API_URL = env.AWS_BUSINESS_API_URL || "";
export const AWS_BUSINESS_API_TOKEN = env.AWS_BUSINESS_API_TOKEN || "";
export const AWS_BUSINESS_SYNC_INTERVAL_MS = env.AWS_BUSINESS_SYNC_INTERVAL_MS;
export const AWS_BUSINESS_MIN_EMPLOYEES = env.AWS_BUSINESS_MIN_EMPLOYEES;
export const AWS_BUSINESS_MIN_LOCATIONS = env.AWS_BUSINESS_MIN_LOCATIONS;
export const AWS_SCHEDULE_SHADOW_READ_ENABLED = env.AWS_SCHEDULE_SHADOW_READ_ENABLED === "true";
export const AWS_SCHEDULE_CANONICAL_READ_ENABLED = env.AWS_SCHEDULE_CANONICAL_READ_ENABLED === "true";
export const AWS_SCHEDULE_NOTIFICATIONS_ENABLED = env.AWS_SCHEDULE_NOTIFICATIONS_ENABLED === "true";
export const AWS_REPLACEMENTS_SHADOW_ENABLED = env.AWS_REPLACEMENTS_SHADOW_ENABLED === "true";
export const AWS_REPLACEMENTS_CANONICAL_ENABLED = env.AWS_REPLACEMENTS_CANONICAL_ENABLED === "true";
export const AWS_REMINDERS_CANONICAL_READ_ENABLED = env.AWS_REMINDERS_CANONICAL_READ_ENABLED === "true";
export const AWS_PREFERENCES_CANONICAL_WRITE_ENABLED = env.AWS_PREFERENCES_CANONICAL_WRITE_ENABLED === "true";

// Helper to parse number arrays
const parseNumArray = (str: string) => str.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
const normalizeMentorName = (value: string) => value
    .replace(/\u0442\u0432\u043e\u044f \u043d\u0430\u0441\u0442\u0430\u0432\u043d\u0438\u0446\u044f/gi, "твій наставник")
    .replace(/\u043d\u0430\u0441\u0442\u0430\u0432\u043d\u0438\u0446\u044f/gi, "наставник")
    .replace(/\u043d\u0430\u0441\u0442\u0430\u0432\u043d\u0438\u0446\u0456/gi, "наставнику")
    .trim();

export const ADMIN_IDS = parseNumArray(env.ADMIN_IDS);
export const CO_FOUNDER_IDS = parseNumArray(env.CO_FOUNDER_IDS);
export const SUPPORT_IDS = parseNumArray(env.SUPPORT_IDS);
export const MENTOR_IDS = parseNumArray(env.MENTOR_IDS);
export const HR_IDS = parseNumArray(env.HR_IDS);
export const HR_NAME = env.HR_NAME;
export const MENTOR_NAME = normalizeMentorName(env.MENTOR_NAME);
export const FINANCE_IDS = parseNumArray(env.FINANCE_IDS);

export const TRAINING_STATUSES = ["ACCEPTED", "TRAINING_SCHEDULED", "TRAINING_COMPLETED", "OFFLINE_STAGING"];

export const GOOGLE_CALENDAR_ID = env.GOOGLE_CALENDAR_ID;
export const TRAINING_CALENDAR_ID = env.TRAINING_CALENDAR_ID;
export const MEET_LINK_HIRING = env.MEET_LINK_HIRING;
export const MEET_LINK_TRAINING = env.MEET_LINK_TRAINING;
export const NDA_LINK = env.NDA_LINK || "";
if (!NDA_LINK) console.warn("⚠️  NDA_LINK is not set — NDA flow will send messages without a document link");
export const KNOWLEDGE_BASE_LINK = env.KNOWLEDGE_BASE_LINK || "https://t.me/+hC9UDoSZb3hiZjFi";
export const TEAM_CHANNEL_LINK = KNOWLEDGE_BASE_LINK; // Alias for knowledge base channel
export const PHOTOGRAPHER_GUIDE_LINK = env.PHOTOGRAPHER_GUIDE_LINK || "";
if (!PHOTOGRAPHER_GUIDE_LINK) console.warn("⚠️  PHOTOGRAPHER_GUIDE_LINK is not set — mentor messages will be sent without a clickable guide link");
export const BACKUP_PASSPHRASE = env.BACKUP_PASSPHRASE;
export const ALLOW_DEV_COMMANDS = env.ALLOW_DEV_COMMANDS === "true";
export const OPENAI_API_KEY = env.OPENAI_API_KEY || "";
export const OPENAI_VISION_MODEL = env.OPENAI_VISION_MODEL || "gpt-5-mini";

export const SUPPORT_CHAT_ID = parseInt(env.SUPPORT_CHAT_ID);
export const RECOVERY_CHAT_ID = parseInt(env.RECOVERY_CHAT_ID);
export const FIRST_SHIFT_ONBOARDING_CHAT_ID = env.FIRST_SHIFT_ONBOARDING_CHAT_ID ? parseInt(env.FIRST_SHIFT_ONBOARDING_CHAT_ID) : null;

// Spreadsheets
export const SPREADSHEET_ID_TECH_CASH = env.SPREADSHEET_ID_TECH_CASH;
export const SPREADSHEET_ID_DDS = env.SPREADSHEET_ID_DDS;
export const SPREADSHEET_ID_SCHEDULE = env.SPREADSHEET_ID_SCHEDULE;
export const SPREADSHEET_ID_TEAM = env.SPREADSHEET_ID_TEAM;

export interface FinanceLocation {
    id: string;
    sheet: string;
    name: string;
    city: string;
    terminalId?: string;
    searchId?: number;
    hasAcquiring?: boolean;
    cashInEnvelope?: boolean;
    fopId?: string;
}

/**
 * ЦЕНТРАЛЬНИЙ КОНФІГ ЛОКАЦІЙ (Актуально на 08.02.2026)
 * @deprecated Використовуйте prisma.location для отримання даних.
 */
export const FINANCE_LOCATIONS: FinanceLocation[] = [];

export const MONO_TOKENS = {
    KUZNETSOV: env.MONO_TOKEN_KUZNETSOV || "",
    POSREDNIKOVA: env.MONO_TOKEN_POSREDNIKOVA || "",
    KARPUK: env.MONO_TOKEN_KARPUK || "",
    GUPALOVA: env.MONO_TOKEN_GUPALOVA || ""
};

export const NOVA_POSHTA_API_KEY = env.NOVA_POSHTA_API_KEY || "";
export const NP_RECIPIENT_PHONE = env.NP_RECIPIENT_PHONE || "";

export const FOP_DISPLAY_NAMES: Record<string, string> = {
    "KUZNETSOV": "Счёт ФОП Кузнецов",
    "POSREDNIKOVA": "Счёт ФОП Посредникова",
    "GUPALOVA": "Счёт ФОП Гупалова",
    "KARPUK": "Счёт ФОП Карпук"
};

export const MONO_FOP_IBANS: Record<string, string[]> = {
    KUZNETSOV: (env.IBAN_KUZNETSOV || "").split(',').map(s => s.trim()).filter(Boolean),
    KARPUK: (env.IBAN_KARPUK || "").split(',').map(s => s.trim()).filter(Boolean),
    GUPALOVA: (env.IBAN_GUPALOVA || "").split(',').map(s => s.trim()).filter(Boolean),
    POSREDNIKOVA: (env.IBAN_POSREDNIKOVA || "").split(',').map(s => s.trim()).filter(Boolean)
};

export const EXCLUDED_IBANS: string[] = [
    "UA143220010000026001300023231", // ФОП Кузнецов (requested for exclusion)
    ...(env.IBAN_EXCLUDED || "").split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
].map(s => s.toUpperCase());

export const DDS_BALANCE_CELLS: Record<string, string> = {
    KUZNETSOV: "'ДДС месяц'!C3",
    POSREDNIKOVA: "'ДДС месяц'!E3",
    KARPUK: "'ДДС месяц'!G1",
    GUPALOVA: "'ДДС месяц'!C2"
};

/**
 * Chat configuration for Broadcasts & Team Management
 */
export const TEAM_CHATS = {
    HUB: parseInt(env.TEAM_HUB_CHAT_ID),
    SUPPORT: parseInt(env.SUPPORT_CHAT_ID),
    CHANNEL: parseInt(env.TEAM_CHANNEL_ID),
    LOGISTICS: env.LOGISTICS_TOPIC_ID ? parseInt(env.LOGISTICS_TOPIC_ID) : undefined,
    RECOVERY: RECOVERY_CHAT_ID,
    FIRST_SHIFT_ONBOARDING: FIRST_SHIFT_ONBOARDING_CHAT_ID
};

/** Map of Ukrainian city names (from sheet headers) → DB city values (Ukrainian) */
export const CITY_NAME_MAP: Record<string, string> = {
    'київ': 'Київ',
    'львів': 'Львів',
    'харків': 'Харків',
    'рівне': 'Рівне',
    'черкаси': 'Черкаси',
    'запоріжжя': 'Запоріжжя',
    'коломия': 'Коломия',
    'самбір': 'Самбір',
    'шептицький': 'Шептицький',
    'хмельницький': 'Хмельницький',
    'даринок': 'Київ',
    'khmelnytskyi': 'Хмельницький',
};

export const PING_CONFIG = {
    INITIAL_DELAY_MS: 20 * 60 * 60 * 1000, // 20 hours
    REPEAT_DELAY_MS: 6 * 60 * 60 * 1000,   // 6 hours
    CHECK_INTERVAL_MS: 60 * 1000           // 1 minute
};
