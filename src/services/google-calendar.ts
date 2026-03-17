import { existsSync } from "fs";
import { google } from 'googleapis';
import path from 'path';
import logger from '../core/logger.js';
import { MEET_LINK_HIRING, MEET_LINK_TRAINING } from '../config.js';

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
            throw new Error("❌ No Google Calendar Service Account found. Please provide google-service-account.json");
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

        if (staticLink) {
            baseEvent.description += `\n\n📹 Google Meet: ${staticLink}`;
        }

        try {
            const response = await calendar.events.insert({
                calendarId: calendarId,
                requestBody: baseEvent,
            });

            return {
                eventId: response.data.id || undefined,
                meetLink: staticLink
            };
        } catch (error: any) {
            logger.error({ err: error.message, calendarId }, "❌ Google Calendar API Error (Event creation failed, but using static link)");
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
        } catch (error) {
            logger.error({ err: error }, '❌ Помилка при видаленні події:');
        }
    }
}

export const googleCalendar = new GoogleCalendarService();
