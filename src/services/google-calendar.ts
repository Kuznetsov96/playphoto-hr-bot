import { existsSync } from "fs";
import { google } from 'googleapis';
import path from 'path';
import logger from '../core/logger.js';
import { MEET_LINK_HIRING, MEET_LINK_TRAINING } from '../config.js';
import { logBusinessEvent } from '../core/log-events.js';

class GoogleCalendarService {
    private serviceAuth: any;

    constructor() {
        const KEY_PATH = path.join(process.cwd(), 'google-service-account.json');
        const hasServiceAccount = existsSync(KEY_PATH);

        // 1. Service Account (Main method)
        if (hasServiceAccount) {
            logger.debug("🎫 Using google-service-account.json for Calendar");
            this.serviceAuth = new google.auth.GoogleAuth({
                keyFile: KEY_PATH,
                scopes: ['https://www.googleapis.com/auth/calendar'],
            });
        }
    }

    private getClient(calendarType?: 'hiring' | 'training') {
        const auth = this.serviceAuth;
        
        if (!auth) {
            throw new Error("No Google Calendar service account found. Please provide google-service-account.json");
        }
        
        return google.calendar({ version: 'v3', auth });
    }

    async createEvent(details: {
        summary: string;
        description: string;
        startTime: Date;
        endTime: Date;
        candidateEmail?: string;
        calendarType?: 'hiring' | 'training';
    }) {
        let calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
        if (details.calendarType === 'training') {
            calendarId = process.env.TRAINING_CALENDAR_ID || calendarId;
        }

        const calendar = this.getClient(details.calendarType);

        const attendees: any[] = details.candidateEmail ? [{ email: details.candidateEmail }] : [];

        const formatForGoogle = (date: Date) => {
            // Prisma dates are UTC. We need to convert them to Kyiv time strings for Google
            // while keeping the 'timeZone' parameter as 'Europe/Kyiv'.
            const kyivDate = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));

            const pad = (n: number) => n.toString().padStart(2, '0');
            return `${kyivDate.getFullYear()}-${pad(kyivDate.getMonth() + 1)}-${pad(kyivDate.getDate())}T${pad(kyivDate.getHours())}:${pad(kyivDate.getMinutes())}:${pad(kyivDate.getSeconds())}`;
        };

        const baseEvent = {
            summary: details.summary,
            description: details.description,
            start: {
                dateTime: formatForGoogle(details.startTime),
                timeZone: 'Europe/Kyiv',
            },
            end: {
                dateTime: formatForGoogle(details.endTime),
                timeZone: 'Europe/Kyiv',
            },
            attendees: attendees,
        };

        const staticLink = details.calendarType === 'training'
            ? MEET_LINK_TRAINING
            : MEET_LINK_HIRING;

        if (!staticLink) {
            logger.warn({ calendarType: details.calendarType }, "Static Meet link is not configured");
            logBusinessEvent({
                event: "integration.google_calendar.meet_link_missing",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                result: "warning",
                reasonCode: "STATIC_MEET_LINK_MISSING",
                module: "google-calendar",
                operation: "createEvent",
                safeContext: {
                    calendarType: details.calendarType || "hiring",
                    calendarId,
                },
            });
        }

        if (staticLink) {
            baseEvent.description += `\n\n📹 Google Meet: ${staticLink}`;
        }

        try {
            const response = await calendar.events.insert({
                calendarId: calendarId,
                requestBody: baseEvent,
            });

            logBusinessEvent({
                event: "integration.google_calendar.event_created",
                actorType: "system",
                actorRole: "system",
                stage: details.calendarType === "training" ? "TRAINING" : "INTERVIEW",
                result: "success",
                module: "google-calendar",
                operation: "createEvent",
                safeContext: {
                    calendarType: details.calendarType || "hiring",
                    calendarId,
                    hasAttendees: attendees.length > 0,
                    startTime: details.startTime.toISOString(),
                    endTime: details.endTime.toISOString(),
                    eventId: response.data.id,
                },
            });

            return {
                eventId: response.data.id || undefined,
                meetLink: staticLink
            };
        } catch (error: any) {
            logger.error({ err: error, calendarId }, "Google Calendar event creation failed");
            logBusinessEvent({
                event: "integration.google_calendar.event_create_failed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                stage: details.calendarType === "training" ? "TRAINING" : "INTERVIEW",
                result: "failed",
                reasonCode: "GOOGLE_CALENDAR_API_ERROR",
                module: "google-calendar",
                operation: "createEvent",
                safeContext: {
                    calendarType: details.calendarType || "hiring",
                    calendarId,
                    hasAttendees: attendees.length > 0,
                    startTime: details.startTime.toISOString(),
                    endTime: details.endTime.toISOString(),
                },
                error,
            });
            return {
                eventId: undefined,
                meetLink: staticLink
            };
        }
    }

    /**
     * Legacy wrapper for backward compatibility
     */
    async createInterviewEvent(details: any) {
        return this.createEvent({ ...details, calendarType: 'hiring' });
    }

    /**
     * Видаляє подію
     */
    async deleteEvent(eventId: string, calendarType: 'hiring' | 'training' = 'hiring') {
        try {
            let calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
            if (calendarType === 'training') {
                calendarId = process.env.TRAINING_CALENDAR_ID || calendarId;
            }

            const calendar = this.getClient(calendarType);

            await calendar.events.delete({
                calendarId: calendarId,
                eventId: eventId,
            });
            logBusinessEvent({
                event: "integration.google_calendar.event_deleted",
                actorType: "system",
                actorRole: "system",
                stage: calendarType === "training" ? "TRAINING" : "INTERVIEW",
                result: "success",
                module: "google-calendar",
                operation: "deleteEvent",
                safeContext: {
                    calendarType,
                    calendarId,
                    eventId,
                },
            });
        } catch (error) {
            logger.error({ err: error, eventId }, "Google Calendar event deletion failed");
            logBusinessEvent({
                event: "integration.google_calendar.event_delete_failed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                stage: calendarType === "training" ? "TRAINING" : "INTERVIEW",
                result: "failed",
                reasonCode: "GOOGLE_CALENDAR_DELETE_FAILED",
                module: "google-calendar",
                operation: "deleteEvent",
                safeContext: {
                    calendarType,
                    eventId,
                },
                error,
            });
        }
    }
}

export const googleCalendar = new GoogleCalendarService();
