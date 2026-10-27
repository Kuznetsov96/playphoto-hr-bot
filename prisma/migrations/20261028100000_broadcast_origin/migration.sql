-- Рассылки из вебаппа: откуда создана и кто автор (initiatorId у них 0).
ALTER TABLE "Broadcast"
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'BOT',
  ADD COLUMN "authorName" TEXT;
