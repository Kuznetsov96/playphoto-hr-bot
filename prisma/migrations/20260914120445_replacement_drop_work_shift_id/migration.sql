/*
  Warnings:

  - You are about to drop the column `workShiftId` on the `ReplacementRequest` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "ReplacementRequest" DROP CONSTRAINT "ReplacementRequest_workShiftId_fkey";

-- AlterTable
ALTER TABLE "ReplacementRequest" DROP COLUMN "workShiftId";
