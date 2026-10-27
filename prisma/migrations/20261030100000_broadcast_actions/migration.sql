-- AlterTable
ALTER TABLE "Broadcast" ADD COLUMN     "manualRemindActionId" UUID,
ADD COLUMN     "manualRemindAt" TIMESTAMP(3),
ADD COLUMN     "remindersStoppedByName" TEXT,
ADD COLUMN     "withdrawnByName" TEXT;

-- CreateTable
CREATE TABLE "BroadcastActionLog" (
    "publicId" UUID NOT NULL,
    "broadcastId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "doneAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" JSONB,

    CONSTRAINT "BroadcastActionLog_pkey" PRIMARY KEY ("publicId")
);

-- CreateTable
CREATE TABLE "BroadcastReminderMark" (
    "broadcastId" INTEGER NOT NULL,
    "chatId" BIGINT NOT NULL,
    "actionPublicId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BroadcastReminderMark_pkey" PRIMARY KEY ("actionPublicId","chatId")
);

-- CreateIndex
CREATE INDEX "BroadcastActionLog_broadcastId_doneAt_idx" ON "BroadcastActionLog"("broadcastId", "doneAt");

-- CreateIndex
CREATE INDEX "BroadcastReminderMark_broadcastId_idx" ON "BroadcastReminderMark"("broadcastId");

-- AddForeignKey
ALTER TABLE "BroadcastActionLog" ADD CONSTRAINT "BroadcastActionLog_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastReminderMark" ADD CONSTRAINT "BroadcastReminderMark_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

