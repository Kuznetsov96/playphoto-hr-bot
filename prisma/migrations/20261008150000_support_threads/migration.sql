-- CreateEnum
CREATE TYPE "SupportThreadStatus" AS ENUM ('WAITING', 'ANSWERED', 'ESCALATED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "SupportThread" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "topicId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "status" "SupportThreadStatus" NOT NULL DEFAULT 'ANSWERED',
    "escalatedToTelegramId" BIGINT,
    "cardMessageId" INTEGER,
    "cardDay" TEXT,
    "noticeDay" TEXT,
    "lastStaffAt" TIMESTAMP(3),
    "lastQuestionAt" TIMESTAMP(3),
    "lastSupportAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportMessageLink" (
    "id" SERIAL NOT NULL,
    "threadId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "topicChatId" BIGINT NOT NULL,
    "topicMessageId" INTEGER NOT NULL,
    "privateChatId" BIGINT,
    "privateMessageId" INTEGER,
    "contextText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessageLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportThread_userId_key" ON "SupportThread"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportThread_chatId_topicId_key" ON "SupportThread"("chatId", "topicId");

-- CreateIndex
CREATE INDEX "SupportMessageLink_privateChatId_privateMessageId_idx" ON "SupportMessageLink"("privateChatId", "privateMessageId");

-- CreateIndex
CREATE INDEX "SupportMessageLink_threadId_createdAt_idx" ON "SupportMessageLink"("threadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportMessageLink_topicChatId_topicMessageId_key" ON "SupportMessageLink"("topicChatId", "topicMessageId");

-- AddForeignKey
ALTER TABLE "SupportThread" ADD CONSTRAINT "SupportThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessageLink" ADD CONSTRAINT "SupportMessageLink_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "SupportThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

