-- Копія списку заборонених Telegram ID з вебаппу.
CREATE TABLE "BlockedTelegramId" (
    "telegramId" BIGINT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedTelegramId_pkey" PRIMARY KEY ("telegramId")
);

-- Переносимо вже заблокованих, щоб блокування не зникло до першого знімка.
INSERT INTO "BlockedTelegramId" ("telegramId") SELECT "telegramId" FROM "User" WHERE "isBlocked" = true ON CONFLICT DO NOTHING;
