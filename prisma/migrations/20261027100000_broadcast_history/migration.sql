-- История рассылок не удаляется: публичный id, withdraw, вид кнопки/вложений,
-- журнал напоминаний, причина несогласия.
-- gen_random_uuid() встроена в PostgreSQL 13+ (в compose/CI — 16).

-- AlterTable
ALTER TABLE "Broadcast"
  ADD COLUMN "publicId" UUID,
  ADD COLUMN "withdrawnAt" TIMESTAMP(3),
  ADD COLUMN "withdrawnByTelegramId" BIGINT,
  ADD COLUMN "buttonType" TEXT,
  ADD COLUMN "attachmentKinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "remindersStoppedAt" TIMESTAMP(3);

-- Backfill существующих строк до уникального ограничения
UPDATE "Broadcast" SET "publicId" = gen_random_uuid() WHERE "publicId" IS NULL;

ALTER TABLE "Broadcast" ALTER COLUMN "publicId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Broadcast_publicId_key" ON "Broadcast"("publicId");

-- AlterTable
ALTER TABLE "PendingReply"
  ADD COLUMN "declineReason" TEXT,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "BroadcastPingLog" (
    "id" SERIAL NOT NULL,
    "broadcastId" INTEGER NOT NULL,
    "chatId" BIGINT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BroadcastPingLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BroadcastPingLog_broadcastId_idx" ON "BroadcastPingLog"("broadcastId");

-- AddForeignKey
ALTER TABLE "BroadcastPingLog" ADD CONSTRAINT "BroadcastPingLog_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;
