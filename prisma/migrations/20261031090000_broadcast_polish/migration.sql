-- AlterTable
ALTER TABLE "Broadcast" ADD COLUMN     "manualRemindActorName" TEXT;

-- AlterTable
ALTER TABLE "BroadcastPingLog" ADD COLUMN     "actorName" TEXT,
ADD COLUMN     "messageId" INTEGER;

-- AlterTable
ALTER TABLE "BroadcastReminderMark" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Broadcast_manualRemindAt_idx" ON "Broadcast"("manualRemindAt");
