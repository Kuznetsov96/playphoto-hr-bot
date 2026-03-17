-- CreateEnum
CREATE TYPE "Role" AS ENUM ('CANDIDATE', 'HR', 'MENTOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT', 'HR_LEAD', 'MENTOR_LEAD');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'CLOSED');

-- CreateEnum
CREATE TYPE "FinanceLogType" AS ENUM ('INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "CandidateStatus" AS ENUM ('SCREENING', 'WAITLIST', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'DECISION_PENDING', 'ACCEPTED', 'REJECTED', 'HIRED', 'MANUAL_REVIEW', 'TRAINING_SCHEDULED', 'TRAINING_COMPLETED', 'OFFLINE_STAGING');

-- CreateEnum
CREATE TYPE "FunnelStep" AS ENUM ('INITIAL_TEST', 'INTERVIEW', 'TRAINING', 'FIRST_SHIFT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "role" "Role" NOT NULL DEFAULT 'CANDIDATE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "adminRole" "AdminRole",

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Broadcast" (
    "id" SERIAL NOT NULL,
    "initiatorId" BIGINT NOT NULL,
    "messageText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "targetSummary" TEXT,

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackedMessage" (
    "id" SERIAL NOT NULL,
    "broadcastId" INTEGER NOT NULL,
    "chatId" BIGINT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "nextPingAt" TIMESTAMP(3),
    "lastPingMsgId" INTEGER,

    CONSTRAINT "TrackedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingReply" (
    "id" SERIAL NOT NULL,
    "trackedMessageId" INTEGER NOT NULL,
    "userId" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "PendingReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" TEXT,
    "birthDate" TIMESTAMP(3),
    "gender" TEXT DEFAULT 'female',
    "city" TEXT,
    "source" TEXT,
    "status" "CandidateStatus" NOT NULL DEFAULT 'SCREENING',
    "locationId" TEXT,
    "interviewSlotId" TEXT,
    "trainingSlotId" TEXT,
    "googleMeetLink" TEXT,
    "trainingMeetLink" TEXT,
    "currentStep" "FunnelStep" NOT NULL DEFAULT 'INITIAL_TEST',
    "isWaitlisted" BOOLEAN NOT NULL DEFAULT false,
    "isHRLocked" BOOLEAN NOT NULL DEFAULT false,
    "isMentorLocked" BOOLEAN NOT NULL DEFAULT true,
    "interviewCompletedAt" TIMESTAMP(3),
    "trainingCompletedAt" TIMESTAMP(3),
    "hrDecision" TEXT,
    "notificationSent" BOOLEAN NOT NULL DEFAULT false,
    "candidateDecision" TEXT,
    "hrScore" INTEGER,
    "mentorScore" INTEGER,
    "hrComment" TEXT,
    "mentorComment" TEXT,
    "appearance" TEXT,
    "hasUnreadMessage" BOOLEAN NOT NULL DEFAULT false,
    "lastSystemMessageId" INTEGER,

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "address" TEXT,
    "neededCount" INTEGER NOT NULL DEFAULT 0,
    "summaryTemplate" TEXT,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "googleMapsLink" TEXT,
    "salary" TEXT,
    "schedule" TEXT,
    "legacyName" TEXT,
    "sheet" TEXT,
    "terminalId" TEXT,
    "searchId" INTEGER,
    "hasAcquiring" BOOLEAN NOT NULL DEFAULT false,
    "cashInEnvelope" BOOLEAN NOT NULL DEFAULT false,
    "fopId" TEXT,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "data" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HRProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "HRProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MentorProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "MentorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewSession" (
    "id" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterviewSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewSlot" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "isBooked" BOOLEAN NOT NULL DEFAULT false,
    "googleEventId" TEXT,
    "reminded6h" BOOLEAN NOT NULL DEFAULT false,
    "reminded10m" BOOLEAN NOT NULL DEFAULT false,
    "reminded2mHR" BOOLEAN NOT NULL DEFAULT false,
    "candidateId" TEXT,
    "lastReminderMsgId" INTEGER,

    CONSTRAINT "InterviewSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingSession" (
    "id" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingSlot" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "isBooked" BOOLEAN NOT NULL DEFAULT false,
    "googleEventId" TEXT,
    "reminded6h" BOOLEAN NOT NULL DEFAULT false,
    "reminded10m" BOOLEAN NOT NULL DEFAULT false,
    "candidateId" TEXT,
    "lastReminderMsgId" INTEGER,

    CONSTRAINT "TrainingSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "content" TEXT,
    "photoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "candidateId" TEXT NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "birthDate" TIMESTAMP(3),
    "onboardingDate" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "fopName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "locationId" TEXT,
    "lastTaskDigestAt" TIMESTAMP(3),

    CONSTRAINT "StaffProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkShift" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "startTime" TIMESTAMP(3),
    "endTime" TIMESTAMP(3),

    CONSTRAINT "WorkShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "taskText" TEXT NOT NULL,
    "workDate" TIMESTAMP(3),
    "deadlineTime" TEXT,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "city" TEXT,
    "locationName" TEXT,
    "fileId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reminderSentAt" TIMESTAMP(3),
    "overdueAdminNotifiedAt" TIMESTAMP(3),

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "isUrgent" BOOLEAN NOT NULL DEFAULT false,
    "issueText" TEXT NOT NULL,
    "topicId" INTEGER,
    "assignedAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceLog" (
    "id" TEXT NOT NULL,
    "type" "FinanceLogType" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "category" TEXT,
    "comment" TEXT,
    "fopAccount" TEXT,
    "locationName" TEXT,
    "isSynced" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adminId" TEXT,

    CONSTRAINT "FinanceLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_userId_key" ON "Candidate"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_interviewSlotId_key" ON "Candidate"("interviewSlotId");

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_trainingSlotId_key" ON "Candidate"("trainingSlotId");

-- CreateIndex
CREATE INDEX "Candidate_status_idx" ON "Candidate"("status");

-- CreateIndex
CREATE INDEX "Candidate_userId_idx" ON "Candidate"("userId");

-- CreateIndex
CREATE INDEX "Candidate_locationId_idx" ON "Candidate"("locationId");

-- CreateIndex
CREATE INDEX "Candidate_city_idx" ON "Candidate"("city");

-- CreateIndex
CREATE UNIQUE INDEX "HRProfile_userId_key" ON "HRProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MentorProfile_userId_key" ON "MentorProfile"("userId");

-- CreateIndex
CREATE INDEX "InterviewSlot_isBooked_startTime_idx" ON "InterviewSlot"("isBooked", "startTime");

-- CreateIndex
CREATE INDEX "InterviewSlot_startTime_idx" ON "InterviewSlot"("startTime");

-- CreateIndex
CREATE UNIQUE INDEX "Session_key_key" ON "Session"("key");

-- CreateIndex
CREATE UNIQUE INDEX "StaffProfile_userId_key" ON "StaffProfile"("userId");

-- CreateIndex
CREATE INDEX "WorkShift_date_idx" ON "WorkShift"("date");

-- CreateIndex
CREATE INDEX "Task_workDate_idx" ON "Task"("workDate");

-- CreateIndex
CREATE INDEX "Task_isCompleted_idx" ON "Task"("isCompleted");

-- CreateIndex
CREATE INDEX "Task_staffId_idx" ON "Task"("staffId");

-- AddForeignKey
ALTER TABLE "TrackedMessage" ADD CONSTRAINT "TrackedMessage_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingReply" ADD CONSTRAINT "PendingReply_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("telegramId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingReply" ADD CONSTRAINT "PendingReply_trackedMessageId_fkey" FOREIGN KEY ("trackedMessageId") REFERENCES "TrackedMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_interviewSlotId_fkey" FOREIGN KEY ("interviewSlotId") REFERENCES "InterviewSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_trainingSlotId_fkey" FOREIGN KEY ("trainingSlotId") REFERENCES "TrainingSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HRProfile" ADD CONSTRAINT "HRProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorProfile" ADD CONSTRAINT "MentorProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewSlot" ADD CONSTRAINT "InterviewSlot_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingSlot" ADD CONSTRAINT "TrainingSlot_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TrainingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffProfile" ADD CONSTRAINT "StaffProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffProfile" ADD CONSTRAINT "StaffProfile_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkShift" ADD CONSTRAINT "WorkShift_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkShift" ADD CONSTRAINT "WorkShift_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
