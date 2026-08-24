-- CreateTable
CREATE TABLE "KnownChat" (
    "id" BIGINT NOT NULL,
    "title" TEXT,
    "type" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lostAt" TIMESTAMP(3),

    CONSTRAINT "KnownChat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnownChat_lostAt_idx" ON "KnownChat"("lostAt");
