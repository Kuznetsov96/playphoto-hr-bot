ALTER TABLE "Parcel"
ADD COLUMN "npTrusteeOrderRef" TEXT,
ADD COLUMN "npTrusteeOrderNumber" TEXT,
ADD COLUMN "npTrusteeError" TEXT,
ADD COLUMN "npTrusteeLastAttemptAt" TIMESTAMP(3);
