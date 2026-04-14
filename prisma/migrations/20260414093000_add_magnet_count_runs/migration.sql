-- CreateEnum
CREATE TYPE "MagnetCountConfidence" AS ENUM ('high', 'medium', 'low');

-- CreateTable
CREATE TABLE "MagnetCountRun" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "photoFileId" TEXT NOT NULL,
    "estimatedTotal" INTEGER NOT NULL,
    "finalTotal" INTEGER,
    "confidence" "MagnetCountConfidence" NOT NULL,
    "stackCounts" TEXT,
    "notes" TEXT,
    "model" TEXT,
    "isManuallyCorrected" BOOLEAN NOT NULL DEFAULT false,
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MagnetCountRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MagnetCountRun_adminUserId_createdAt_idx" ON "MagnetCountRun"("adminUserId", "createdAt");

-- CreateIndex
CREATE INDEX "MagnetCountRun_createdAt_idx" ON "MagnetCountRun"("createdAt");

-- AddForeignKey
ALTER TABLE "MagnetCountRun" ADD CONSTRAINT "MagnetCountRun_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
