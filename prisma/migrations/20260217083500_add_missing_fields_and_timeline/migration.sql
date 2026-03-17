-- AlterTable
ALTER TABLE "User" ADD COLUMN "lastSupportMessageId" INTEGER;

-- CreateTable
CREATE TABLE "UserTimelineEvent" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "text" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserTimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserTimelineEvent_userId_idx" ON "UserTimelineEvent"("userId");
CREATE INDEX "UserTimelineEvent_createdAt_idx" ON "UserTimelineEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "UserTimelineEvent" ADD CONSTRAINT "UserTimelineEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
