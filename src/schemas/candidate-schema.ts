import { z } from "zod";

export const CandidateSchema = z.object({
    fullName: z.string()
        .min(5, "ПІБ має бути не менше 5 символів")
        .max(100, "ПІБ занадто довге")
        .refine(val => val.trim().split(/\s+/).length >= 2, "Введіть Ім'я та Прізвище (через пробіл)")
        .refine(val => !val.startsWith("/"), "Це схоже на команду, введіть ім'я")
        .refine(val => !/\d/.test(val), "Ім'я не може містити цифри"),
    
    birthDate: z.date()
        .refine(date => {
            const today = new Date();
            let age = today.getFullYear() - date.getFullYear();
            const m = today.getMonth() - date.getMonth();
            if (m < 0 || (m === 0 && today.getDate() < date.getDate())) {
                age--;
            }
            return age >= 17;
        }, "Ми приймаємо на роботу лише з 17 років")
        .refine(date => date > new Date(1950, 0, 1), "Введіть реальну дату народження"),

    phone: z.string()
        .regex(/^\+380\d{9}$/, "Будь ласка, введи коректний номер телефону у форматі +380XXXXXXXXX"),
    
    email: z.string()
        .email("Це не схоже на правильний Email. Будь ласка, спробуй ще раз."),
    
    city: z.string()
        .min(2, "Назва міста має бути не коротшою за 2 символи.")
        .regex(/^[a-zA-Zа-яА-ЯіїєІЇЄ\s-]+$/, "Назва міста має містити лише букви.")
});

export const parseBirthDate = (text: string): Date | null => {
    if (!/^\d{2}\.\d{2}\.\d{4}$/.test(text)) return null;
    const [d, m, y] = text.split(".").map(Number);
    const date = new Date(y!, m! - 1, d!);
    if (!isNaN(date.getTime()) && date.getDate() === d) return date;
    return null;
};
