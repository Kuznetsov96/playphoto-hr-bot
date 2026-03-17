-- CreateTable
CREATE TABLE IF NOT EXISTS "ChatLog" (
    "id"          SERIAL NOT NULL,
    "telegramId"  BIGINT NOT NULL,
    "userId"      TEXT,
    "direction"   TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "text"        TEXT,
    "mediaFileId" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChatLog_telegramId_idx" ON "ChatLog"("telegramId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChatLog_userId_idx" ON "ChatLog"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChatLog_createdAt_idx" ON "ChatLog"("createdAt");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'ChatLog_userId_fkey'
          AND table_name = 'ChatLog'
    ) THEN
        ALTER TABLE "ChatLog"
            ADD CONSTRAINT "ChatLog_userId_fkey"
            FOREIGN KEY ("userId")
            REFERENCES "User"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
