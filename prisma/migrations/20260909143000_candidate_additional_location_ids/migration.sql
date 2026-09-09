-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN     "additionalLocationIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
