-- CreateIndex
CREATE INDEX "TrackedMessage_nextPingAt_idx" ON "TrackedMessage"("nextPingAt");

-- CreateIndex
CREATE INDEX "TrackedMessage_broadcastId_idx" ON "TrackedMessage"("broadcastId");

-- CreateIndex
CREATE INDEX "PendingReply_userId_status_idx" ON "PendingReply"("userId", "status");

-- CreateIndex
CREATE INDEX "PendingReply_trackedMessageId_idx" ON "PendingReply"("trackedMessageId");

-- CreateIndex
CREATE INDEX "TrainingSlot_startTime_idx" ON "TrainingSlot"("startTime");

-- CreateIndex
CREATE INDEX "TrainingSlot_sessionId_idx" ON "TrainingSlot"("sessionId");

-- CreateIndex
CREATE INDEX "Message_candidateId_createdAt_idx" ON "Message"("candidateId", "createdAt");

-- CreateIndex
CREATE INDEX "StaffProfile_isActive_idx" ON "StaffProfile"("isActive");

-- CreateIndex
CREATE INDEX "StaffProfile_locationId_isActive_idx" ON "StaffProfile"("locationId", "isActive");

-- CreateIndex
CREATE INDEX "SupportTicket_userId_status_idx" ON "SupportTicket"("userId", "status");

-- CreateIndex
CREATE INDEX "SupportTicket_status_idx" ON "SupportTicket"("status");

-- CreateIndex
CREATE INDEX "SupportTicket_topicId_idx" ON "SupportTicket"("topicId");

