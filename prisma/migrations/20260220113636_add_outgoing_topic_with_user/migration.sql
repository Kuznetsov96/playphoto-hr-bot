-- CreateTable
CREATE TABLE "OutgoingTopic" (
    "id" SERIAL NOT NULL,
    "chatId" BIGINT NOT NULL,
    "topicId" INTEGER NOT NULL,
    "staffName" TEXT,
    "userId" TEXT,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutgoingTopic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutgoingTopic_isClosed_createdAt_idx" ON "OutgoingTopic"("isClosed", "createdAt");

-- CreateIndex
CREATE INDEX "OutgoingTopic_userId_idx" ON "OutgoingTopic"("userId");

-- AddForeignKey
ALTER TABLE "OutgoingTopic" ADD CONSTRAINT "OutgoingTopic_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
