-- CreateEnum
CREATE TYPE "LeadPlatform" AS ENUM ('INSTAGRAM', 'OLX', 'WORK_UA', 'MANUAL');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'INVITED', 'IN_PROGRESS', 'CONVERTED', 'CLOSED');

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "platform" "LeadPlatform" NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "lastMessage" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "topicId" INTEGER,
    "candidateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadMessage" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "text" TEXT,
    "mediaUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Lead_externalId_key" ON "Lead"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_candidateId_key" ON "Lead"("candidateId");

-- CreateIndex
CREATE INDEX "Lead_externalId_idx" ON "Lead"("externalId");

-- CreateIndex
CREATE INDEX "Lead_status_idx" ON "Lead"("status");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadMessage" ADD CONSTRAINT "LeadMessage_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

