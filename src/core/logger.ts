import pino from "pino";
import type { LoggerOptions } from "pino";
import fs from "fs";
import path from "path";
import { sanitizeTextForLogs } from "./log-sanitizer.js";

/**
 * PlayPhoto Security Logger Configuration.
 * Automatically redacts sensitive fields to prevent PII (Personally Identifiable Information)
 * leaks into log files, even in debug mode.
 */
export const REDACT_CONFIG = {
    paths: [
        "*.password",
        "*.token",
        "*.secret",
        "*.apiKey",
        "*.api_key",
        "*.accessToken",
        "*.access_token",
        "*.refreshToken",
        "*.refresh_token",
        "*.authorization",
        "*.cookie",
        "*.cookies",
        "*.set-cookie",
        "*.proxyPass",
        "*.proxyPassword",
        "*.iban",
        "*.passportNumber",
        "*.ipn",
        "*.bankCard",
        "*.registrationAddress",
        "*.phone",
        "*.fullName",
        "*.email",
        "*.firstName",
        "*.lastName",
        "*.username",
        "payload.iban",
        "payload.passportNumber",
        "payload.ipn",
        "payload.bankCard",
        "ctx.message.text",
        "ctx.message.caption",
        "ctx.update.message.text",
        "ctx.update.message.caption",
        "ctx.message.from.first_name",
        "ctx.message.from.last_name",
        "ctx.message.from.username",
        "ctx.from.first_name",
        "ctx.from.last_name",
        "ctx.from.username",
        "ctx.callbackQuery.data",
        "user.firstName",
        "user.lastName",
        "user.username",
        "candidate.fullName",
        "staffProfile.fullName",
        "err.config.headers.Authorization",
        "err.config.headers.authorization",
        "err.request.headers.Authorization",
        "err.request.headers.authorization",
        "err.response.config.headers.Authorization",
        "err.response.config.headers.authorization",
        "error.config.headers.Authorization",
        "error.config.headers.authorization",
        "error.request.headers.Authorization",
        "error.request.headers.authorization",
        "error.response.config.headers.Authorization",
        "error.response.config.headers.authorization",
        "headers.authorization",
        "headers.Authorization",
        "request.headers.authorization",
        "request.headers.Authorization",
        "response.config.headers.authorization",
        "response.config.headers.Authorization"
    ],
    censor: "[PROTECTED]",
};

function sanitizeErrorObject(error: unknown) {
    if (!(error instanceof Error)) return error;

    const errorWithExtras = error as Error & {
        code?: string;
        status?: number;
        statusCode?: number;
        response?: { status?: number };
        cause?: unknown;
    };

    return {
        type: error.name,
        message: sanitizeTextForLogs(error.message) || error.message,
        code: errorWithExtras.code,
        status: errorWithExtras.status ?? errorWithExtras.statusCode ?? errorWithExtras.response?.status,
        cause: errorWithExtras.cause instanceof Error
            ? {
                type: errorWithExtras.cause.name,
                message: sanitizeTextForLogs(errorWithExtras.cause.message) || errorWithExtras.cause.message,
            }
            : undefined,
        stack: process.env.NODE_ENV === "production"
            ? undefined
            : sanitizeTextForLogs(error.stack),
    };
}

const pinoOptions: LoggerOptions = {
    level: process.env.LOG_LEVEL || "info",
    redact: REDACT_CONFIG,
    serializers: {
        err: sanitizeErrorObject,
        error: sanitizeErrorObject,
    },
    base: {
        service: "playphoto-hr-bot",
        env: process.env.NODE_ENV || "development",
    }
};

const isProd = process.env.NODE_ENV === "production";
let logger: pino.Logger;
export type ReopenableDestination = pino.DestinationStream & { reopen: () => void };
export let productDestination: ReopenableDestination | undefined;

if (isProd) {
    // In production, we write to both stdout and a persistent file
    const logDir = "/app/logs";
    const logPath = path.join(logDir, "product.log");

    if (!fs.existsSync(logDir)) {
        try {
            fs.mkdirSync(logDir, { recursive: true });
        } catch (e) {
            console.error("❌ Failed to create log directory:", e);
        }
    }

    const streams = [
        { stream: process.stdout },
        {
            stream: (productDestination = pino.destination({
                dest: logPath,
                minLength: 4096,
                sync: false,
                append: true
            }) as ReopenableDestination)
        },
    ];

    logger = pino(pinoOptions, pino.multistream(streams));
} else {
    // In development, use pino-pretty for better readability
    pinoOptions.transport = {
        target: 'pino-pretty',
        options: {
            colorize: true
        }
    };
    logger = pino(pinoOptions);
}

export default logger;
