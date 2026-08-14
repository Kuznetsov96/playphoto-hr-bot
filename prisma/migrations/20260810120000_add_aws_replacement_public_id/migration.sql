-- AlterTable
ALTER TABLE "ReplacementRequest" ADD COLUMN "awsReplacementPublicId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ReplacementRequest_awsReplacementPublicId_key" ON "ReplacementRequest"("awsReplacementPublicId");
