CREATE TABLE "BroadcastDelivery" (
    "id" SERIAL NOT NULL,
    "broadcastId" INTEGER NOT NULL,
    "chatId" BIGINT NOT NULL,
    "targetType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "messageId" INTEGER,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BroadcastDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BroadcastDelivery_broadcastId_chatId_key"
ON "BroadcastDelivery"("broadcastId", "chatId");

CREATE INDEX "BroadcastDelivery_broadcastId_status_idx"
ON "BroadcastDelivery"("broadcastId", "status");

ALTER TABLE "BroadcastDelivery"
ADD CONSTRAINT "BroadcastDelivery_broadcastId_fkey"
FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Keep one canonical active support route per user before enforcing the invariant.
WITH ranked AS (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "userId" ORDER BY "updatedAt" DESC, "id" DESC) AS row_number
    FROM "SupportTicket"
    WHERE "status" IN ('OPEN', 'IN_PROGRESS')
)
UPDATE "SupportTicket"
SET "status" = 'CLOSED'
WHERE "id" IN (SELECT "id" FROM ranked WHERE row_number > 1);

WITH ranked AS (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "userId" ORDER BY "updatedAt" DESC, "id" DESC) AS row_number
    FROM "OutgoingTopic"
    WHERE "userId" IS NOT NULL AND "isClosed" = false
)
UPDATE "OutgoingTopic"
SET "isClosed" = true
WHERE "id" IN (SELECT "id" FROM ranked WHERE row_number > 1);

CREATE UNIQUE INDEX "SupportTicket_one_active_per_user_key"
ON "SupportTicket"("userId")
WHERE "status" IN ('OPEN', 'IN_PROGRESS');

CREATE UNIQUE INDEX "OutgoingTopic_one_active_per_user_key"
ON "OutgoingTopic"("userId")
WHERE "userId" IS NOT NULL AND "isClosed" = false;
