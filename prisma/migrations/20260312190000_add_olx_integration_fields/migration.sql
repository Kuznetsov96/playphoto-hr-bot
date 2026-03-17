-- AlterTable
ALTER TABLE "Lead" ADD COLUMN "platformAdId" TEXT,
ADD COLUMN "platformThreadId" TEXT;

-- CreateTable
CREATE TABLE "ExternalToken" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Lead_platformThreadId_key" ON "Lead"("platformThreadId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalToken_service_key" ON "ExternalToken"("service");
