import { candidateRepository } from "../../../repositories/candidate-repository.js";
import { teamRegistrationService } from "../../../services/team-registration-service.js";
import { locationRepository } from "../../../repositories/location-repository.js";
import { ADMIN_IDS, BACKUP_PASSPHRASE, SPREADSHEET_ID_TEAM } from "../../../config.js";
import { getBankNameByIban } from "../../../utils/iban-utils.js";
import logger from "../../../core/logger.js";
import path from "path";
import fs from "fs/promises";
import os from "os";
import AdmZip from "adm-zip";
import { InputFile } from "grammy";

export class CandidateService {
    async processOnboardingFinish(api: any, candidate: any) {
        const candidateId = candidate?.id;
        const fullName = candidate?.fullName || "Unknown";
        logger.info({ candidateId, fullName }, "🚀 processOnboardingFinish: Starting background tasks...");
        
        // 1. GOOGLE SHEET REGISTRATION
        try {
            if (!candidate?.user?.telegramId) {
                throw new Error(`Candidate user data missing: telegramId not found for ${fullName} (${candidateId})`);
            }

            logger.debug({ candidateId }, "📝 Attempting Google Sheets registration...");
            const locId = candidate.locationId;
            const loc = locId ? await locationRepository.findById(locId) : null;
            
            const regResult = await teamRegistrationService.registerNewHire({
                fullName: candidate.fullName || "—",
                phone: candidate.phone || "—",
                email: candidate.email || "—",
                telegramId: candidate.user.telegramId.toString(),
                username: candidate.user.username || "—",
                instagram: candidate.instagram || "—",
                iban: candidate.iban || "—",
                city: candidate.city || "—",
                locationName: loc?.name || "—",
                birthDate: candidate.birthDate
            });

            if (regResult && ADMIN_IDS[0]) {
                logger.info({ candidateId }, "✅ Registration success. Notifying admin...");
                await api.sendMessage(ADMIN_IDS[0], `✅ <b>${fullName}</b> автоматично додана в таблицю TEAM! 📝`, { parse_mode: "HTML" }).catch(() => {});
            }
        } catch (regErr: any) {
            const errorMsg = regErr.message || "Unknown error";
            logger.error({ 
                err: errorMsg, 
                candidateId,
                fullName,
                spreadsheetId: SPREADSHEET_ID_TEAM,
                stack: regErr.stack
            }, "Failed to auto-register in TEAM sheet");
            
            if (ADMIN_IDS[0]) {
                await api.sendMessage(ADMIN_IDS[0], `❌ Помилка додавання <b>${fullName}</b> в таблицю TEAM: <code>${errorMsg}</code>`, { parse_mode: "HTML" }).catch(() => {});
            }
        }

        // 2. MEDIA HANDLING (Secondary Priority, Background)
        logger.debug({ candidateId: candidate.id }, "📁 Handling media (passport photos)...");
        const fileIds = (candidate.passportPhotoIds || "").split(',').filter(Boolean);
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `onb-${candidate.id}-`));

        try {
            const zip = new AdmZip();
            
            const infoContent = `
CANDIDATE PROFILE
----------------
Full Name: ${candidate.fullName}
Phone: ${candidate.phone || '—'}
Email: ${candidate.email || '—'}
Telegram ID: ${candidate.user.telegramId}
Username: @${candidate.user.username || '—'}
Instagram: ${candidate.instagram || '—'}
IBAN: ${candidate.iban || '—'}
Bank: ${getBankNameByIban(candidate.iban)}
City: ${candidate.city || '—'}
            `.trim();
            
            zip.addFile("Candidate_Info.txt", Buffer.from(infoContent, "utf8"));

            for (let i = 0; i < fileIds.length; i++) {
                const file = await api.getFile(fileIds[i]);
                if (file.file_path) {
                    const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
                    const response = await fetch(url);
                    if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
                    const arrayBuffer = await response.arrayBuffer();
                    zip.addFile(`doc_${i + 1}.jpg`, Buffer.from(arrayBuffer));
                }
            }

            const zipName = `Docs_${candidate.fullName.replace(/\s+/g, '_')}.zip`;
            const zipPath = path.join(os.tmpdir(), zipName);
            
            zip.writeZip(zipPath);

            if (ADMIN_IDS[0]) {
                const caption = `📁 <b>Нові документи та анкета</b>\n\n` +
                    `👤 Ім'я: ${candidate.fullName}\n` +
                    `🏙️ Місто: ${candidate.city || '—'}\n\n` +
                    `🔒 <i>Вся персональна інформація (тел, email, IBAN) знаходиться всередині архіву.</i>`;
                await api.sendDocument(ADMIN_IDS[0], new InputFile(zipPath), { caption, parse_mode: "HTML" });
            }
            await fs.unlink(zipPath).catch(() => {});
        } catch (mediaErr) {
            logger.error({ err: mediaErr }, "Failed to process documents media");
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
    }
}

export const candidateService = new CandidateService();
