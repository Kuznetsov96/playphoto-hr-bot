# Mentor Waitlist Bug Fix & Enum Split

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 bugs in the mentor waitlist flow that allow unvetted candidates to receive materials and cycle between WAITLIST/ACCEPTED, then split WAITLIST into two enum values for permanent safety.

**Architecture:** Phase A adds guards to 4 existing functions + SQL data fix. Phase B adds `WAITLIST_HR` / `WAITLIST_MENTOR` enum values in Prisma, migrates all references, and updates queries. Both phases are incremental — no architectural rewrites.

**Tech Stack:** TypeScript, Prisma ORM, PostgreSQL, grammY, Vitest

---

## Phase A: Guards + Data Fix

### Task 1: Fix `sendMaterials()` — reject candidates without HR approval

**Files:**
- Modify: `src/services/mentor-service.ts:169-200`
- Test: `src/services/__tests__/mentor-service.test.ts` (create)

- [ ] **Step 1: Create test file with failing test for sendMaterials guard**

Create `src/services/__tests__/mentor-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CandidateStatus, FunnelStep } from '@prisma/client';

vi.mock('../../db/core.js', () => ({
    default: {
        candidate: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        trainingSlot: { count: vi.fn().mockResolvedValue(0) }
    }
}));

vi.mock('../../repositories/candidate-repository.js', () => ({
    candidateRepository: {
        findById: vi.fn(),
        update: vi.fn(),
        findByStatusWithUser: vi.fn().mockResolvedValue([]),
        findByStatus: vi.fn().mockResolvedValue([]),
        countByStatus: vi.fn().mockResolvedValue(0),
        countUnreadByScope: vi.fn().mockResolvedValue(0),
        findUnreadByScope: vi.fn().mockResolvedValue([]),
        findByCityAndStatus: vi.fn().mockResolvedValue([])
    }
}));

vi.mock('../../repositories/training-repository.js', () => ({
    trainingRepository: {
        countBookedSlotsByDateRange: vi.fn().mockResolvedValue(0)
    }
}));

vi.mock('../../repositories/location-repository.js', () => ({
    locationRepository: {}
}));

vi.mock('../access-service.js', () => ({
    accessService: {
        createInviteLink: vi.fn().mockResolvedValue('https://t.me/+test'),
        staticJoinLink: 'https://t.me/+static'
    }
}));

vi.mock('../../config.js', () => ({
    ADMIN_IDS: [],
    KNOWLEDGE_BASE_LINK: 'https://kb.test',
    NDA_LINK: 'https://nda.test',
    PHOTOGRAPHER_GUIDE_LINK: 'https://guide.test',
    MENTOR_IDS: []
}));

vi.mock('../../utils/cleanup.js', () => ({
    cleanupUserSessionMessages: vi.fn()
}));

vi.mock('../../utils/bot-blocked.js', () => ({
    isBotBlocked: vi.fn().mockReturnValue(false),
    handleBlockedCandidate: vi.fn()
}));

vi.mock('../../utils/bot-utils.js', () => ({
    createKyivDate: vi.fn()
}));

vi.mock('../../utils/location-data-helper.js', () => ({
    getLocationDetails: vi.fn()
}));

vi.mock('../../constants/candidate-texts.js', () => ({
    CANDIDATE_TEXTS: {
        "discovery-invite": () => "Test discovery invite text"
    }
}));

vi.mock('../../repositories/timeline-repository.js', () => ({
    timelineRepository: { createEvent: vi.fn() }
}));

import { mentorService } from '../mentor-service.js';
import { candidateRepository } from '../../repositories/candidate-repository.js';

describe('MentorService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('sendMaterials', () => {
        it('should reject candidate without hrDecision=ACCEPTED', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                id: 'cand1',
                status: CandidateStatus.WAITLIST,
                hrDecision: null,
                currentStep: FunnelStep.INITIAL_TEST,
                isWaitlisted: true,
                materialsSent: false,
                user: { telegramId: 123n }
            } as any);

            const result = await mentorService.sendMaterials({} as any, 'cand1');

            expect(result).toBeNull();
            expect(candidateRepository.update).not.toHaveBeenCalled();
        });

        it('should allow candidate with hrDecision=ACCEPTED and currentStep=TRAINING', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                id: 'cand2',
                status: CandidateStatus.WAITLIST,
                hrDecision: 'ACCEPTED',
                currentStep: FunnelStep.TRAINING,
                isWaitlisted: true,
                materialsSent: true,
                discoverySlotId: null,
                user: { telegramId: 456n }
            } as any);

            const result = await mentorService.sendMaterials({} as any, 'cand2');

            expect(result).not.toBeNull();
            expect(result?.telegramId).toBe(456);
            expect(candidateRepository.update).toHaveBeenCalled();
        });

        it('should allow ACCEPTED candidate with materialsSent=false (first-time materials)', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                id: 'cand3',
                status: CandidateStatus.ACCEPTED,
                hrDecision: 'ACCEPTED',
                notificationSent: true,
                currentStep: FunnelStep.TRAINING,
                isWaitlisted: false,
                materialsSent: false,
                user: { telegramId: 789n }
            } as any);

            const result = await mentorService.sendMaterials({} as any, 'cand3');

            expect(result).not.toBeNull();
            expect(candidateRepository.update).toHaveBeenCalled();
        });
    });

    describe('notifyWaitlist', () => {
        it('should skip candidates with currentStep != TRAINING', async () => {
            vi.mocked(candidateRepository.findByStatus).mockResolvedValue([
                {
                    id: 'cand-hr',
                    status: CandidateStatus.WAITLIST,
                    currentStep: FunnelStep.INITIAL_TEST,
                    isWaitlisted: true,
                    hrDecision: null,
                    user: { telegramId: 111n }
                } as any,
                {
                    id: 'cand-mentor',
                    status: CandidateStatus.WAITLIST,
                    currentStep: FunnelStep.TRAINING,
                    isWaitlisted: true,
                    hrDecision: 'ACCEPTED',
                    user: { telegramId: 222n }
                } as any
            ]);

            const mockApi = { sendMessage: vi.fn().mockResolvedValue({}) };
            const count = await mentorService.notifyWaitlist(mockApi);

            expect(count).toBe(1);
            expect(mockApi.sendMessage).toHaveBeenCalledTimes(1);
            expect(mockApi.sendMessage).toHaveBeenCalledWith(222, expect.any(String), expect.any(Object));
            // HR waitlist candidate should NOT have been updated
            expect(candidateRepository.update).toHaveBeenCalledTimes(1);
            expect(candidateRepository.update).toHaveBeenCalledWith('cand-mentor', expect.objectContaining({
                status: 'ACCEPTED',
                isWaitlisted: false
            }));
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/__tests__/mentor-service.test.ts`
Expected: FAIL — sendMaterials doesn't check hrDecision yet, notifyWaitlist doesn't filter by currentStep.

- [ ] **Step 3: Add guard to `sendMaterials()`**

In `src/services/mentor-service.ts`, replace lines 169-200 with:

```typescript
    async sendMaterials(api: any, candId: string) {
        const cand = await candidateRepository.findById(candId);
        if (!cand) return null;

        // Guard: only candidates who passed HR review can receive materials
        const isHRApproved = cand.hrDecision === "ACCEPTED";
        const isAlreadyInMentorFlow = cand.currentStep === FunnelStep.TRAINING && cand.materialsSent;

        if (!isHRApproved && !isAlreadyInMentorFlow) {
            logger.warn({ candId, status: cand.status, hrDecision: cand.hrDecision, currentStep: cand.currentStep },
                "⚠️ sendMaterials blocked: candidate not HR-approved");
            return null;
        }

        let msgText = "";

        if (cand.status === "WAITLIST") {
            msgText = `Привіт! ✨\n\nЗ'явилися нові вільні вікна для нашої короткої зустрічі-знайомства. Тисни кнопку нижче, щоб обрати зручний час! 👇`;
        } else if (cand.materialsSent && !cand.discoverySlotId) {
            msgText = `Привіт! ✨\n\nНагадую про запис на відеозустріч-знайомство. Чи вдалося ознайомитись з матеріалами? 📚\n\nОбери зручний час за кнопкою нижче! 👇`;
        } else {
            const channelLink = cand.user
                ? (await accessService.createInviteLink(cand.user.telegramId)) || accessService.staticJoinLink
                : accessService.staticJoinLink;
            msgText = CANDIDATE_TEXTS["discovery-invite"](KNOWLEDGE_BASE_LINK, channelLink, PHOTOGRAPHER_GUIDE_LINK);
        }

        await candidateRepository.update(candId, {
            materialsSent: true,
            materialsSentAt: new Date(),
            status: "ACCEPTED",
            notificationSent: true,
            isWaitlisted: false
        });

        if (cand.user) {
            await cleanupUserSessionMessages(new Bot(process.env.BOT_TOKEN!) as any, Number(cand.user.telegramId));
            return { telegramId: Number(cand.user.telegramId), text: msgText };
        }

        return null;
    }
```

- [ ] **Step 4: Add filter to `notifyWaitlist()`**

In `src/services/mentor-service.ts`, replace lines 202-228 with:

```typescript
    async notifyWaitlist(api: any) {
        const all = await candidateRepository.findByStatus("WAITLIST", true);

        // Only notify mentor-waitlist candidates (passed HR, stuck on slot booking)
        const filtered = all.filter(c =>
            c.currentStep === FunnelStep.TRAINING && c.hrDecision === "ACCEPTED"
        );

        let successCount = 0;
        for (const cand of filtered) {
            try {
                const text = `Привіт! ✨\n\nЗ'явилися нові вільні вікна для нашої зустрічі. Тисни кнопку нижче, щоб обрати зручний час! 👇`;
                const kb = new InlineKeyboard().text("🗓️ Обрати час", "start_training_scheduling");

                if (cand.user) {
                    await api.sendMessage(Number(cand.user.telegramId), text, { reply_markup: kb });

                    await candidateRepository.update(cand.id, {
                        status: "ACCEPTED",
                        isWaitlisted: false,
                        materialsSent: true,
                        materialsSentAt: new Date()
                    });
                    successCount++;
                }
            } catch (e: any) {
                if (isBotBlocked(e)) await handleBlockedCandidate(api, cand.id, cand.fullName || "Candidate");
                else logger.error({ err: e, userId: cand.user.telegramId }, "Failed to notify waitlist candidate");
            }
        }
        return successCount;
    }
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/services/__tests__/mentor-service.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/mentor-service.ts src/services/__tests__/mentor-service.test.ts
git commit -m "fix(mentor): add HR-approval guard to sendMaterials and filter notifyWaitlist by currentStep"
```

---

### Task 2: Fix `start_training_scheduling` callback — validate candidate status

**Files:**
- Modify: `src/handlers/booking.ts:70-88` (callback guard)
- Modify: `src/handlers/booking.ts:426-464` (handler)

- [ ] **Step 1: Add WAITLIST with wrong step to training callback guard**

In `src/handlers/booking.ts`, replace the training actions guard (lines 70-88) with:

```typescript
    // 2. Training actions guard
    if (trainingActions.some(a => data.startsWith(a))) {
        const forbiddenStatuses: CandidateStatus[] = [
            CandidateStatus.TRAINING_COMPLETED,
            CandidateStatus.OFFLINE_STAGING,
            CandidateStatus.AWAITING_FIRST_SHIFT,
            CandidateStatus.HIRED,
            CandidateStatus.NDA,
            CandidateStatus.KNOWLEDGE_TEST,
            CandidateStatus.STAGING_SETUP,
            CandidateStatus.STAGING_ACTIVE,
            CandidateStatus.READY_FOR_HIRE,
            CandidateStatus.SCREENING,
            CandidateStatus.REJECTED
        ];
        if (forbiddenStatuses.includes(candidate.status)) {
            await ctx.answerCallbackQuery("⚠️ Твоє навчання вже завершене! Оновлюю меню... ✨");
            const { showCandidateStatus } = await import("../utils/candidate-ui.js");
            await showCandidateStatus(ctx, candidate);
            return;
        }
        // Block HR-waitlist candidates (no HR approval yet)
        if (candidate.status === CandidateStatus.WAITLIST && candidate.currentStep !== FunnelStep.TRAINING) {
            await ctx.answerCallbackQuery("⏳ Твоя заявка ще на розгляді у HR.");
            const { showCandidateStatus } = await import("../utils/candidate-ui.js");
            await showCandidateStatus(ctx, candidate);
            return;
        }
    }
```

- [ ] **Step 2: Add status check inside `start_training_scheduling` handler**

In `src/handlers/booking.ts`, after `const telegramId = ctx.from.id;` (line 429), add candidate status validation:

```typescript
bookingHandlers.callbackQuery("start_training_scheduling", async (ctx) => {
    await ctx.answerCallbackQuery();

    const telegramId = ctx.from.id;

    // Validate candidate is eligible for training scheduling
    const candidate = await candidateRepository.findByTelegramId(telegramId);
    if (!candidate) return;

    const allowedStatuses: CandidateStatus[] = [
        CandidateStatus.ACCEPTED,
        CandidateStatus.DISCOVERY_COMPLETED,
        CandidateStatus.TRAINING_SCHEDULED
    ];
    const isWaitlistMentor = candidate.status === CandidateStatus.WAITLIST && candidate.currentStep === FunnelStep.TRAINING;

    if (!allowedStatuses.includes(candidate.status) && !isWaitlistMentor) {
        logger.warn({ userId: telegramId, status: candidate.status, currentStep: candidate.currentStep },
            "⚠️ start_training_scheduling blocked: invalid candidate status");
        const { showCandidateStatus } = await import("../utils/candidate-ui.js");
        await showCandidateStatus(ctx, candidate);
        return;
    }

    const slots = await trainingRepository.findActiveSlots();
```

The rest of the handler stays unchanged.

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/handlers/booking.ts
git commit -m "fix(booking): add status validation to start_training_scheduling and callback guard"
```

---

### Task 3: Fix mentor inbox — hide HR-waitlist candidates from mentor

**Files:**
- Modify: `src/menus/mentor.ts:303` (details menu guard)

- [ ] **Step 1: Add guard in mentor inbox details for WAITLIST candidates**

In `src/menus/mentor.ts`, replace line 303:

```typescript
    else if (cand.status === "ACCEPTED" || cand.status === "WAITLIST") {
```

with:

```typescript
    else if (cand.status === "ACCEPTED" || (cand.status === "WAITLIST" && cand.currentStep === FunnelStep.TRAINING)) {
```

This ensures the "Send Materials" / "Send Reminder" buttons only appear for mentor-waitlist candidates, not HR-waitlist.

- [ ] **Step 2: Add FunnelStep import if not already present**

Check imports at top of `src/menus/mentor.ts`. Ensure `FunnelStep` is imported:

```typescript
import { CandidateStatus, FunnelStep } from "@prisma/client";
```

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/menus/mentor.ts
git commit -m "fix(mentor): hide HR-waitlist candidates from mentor inbox actions"
```

---

### Task 4: Fix data — restore wrongly promoted candidates via SQL

**Files:**
- Run SQL on production server

- [ ] **Step 1: Identify affected candidates**

Candidates who should be restored to WAITLIST with `currentStep: INITIAL_TEST`:
- All candidates with `isOtherCity = true` AND `locationId IS NULL` AND `hrDecision IS NULL` who are currently in WAITLIST with `currentStep = 'TRAINING'`
- All candidates with same conditions who are currently ACCEPTED (were moved there by buggy sendMaterials)

Run on server to verify counts first:

```bash
ssh playphoto "docker exec playphoto_hr_bot-postgres-1 psql -U postgres -d playphoto_bot -c \"
SELECT count(*), status, \\\"currentStep\\\"
FROM \\\"Candidate\\\"
WHERE \\\"isOtherCity\\\" = true
  AND \\\"locationId\\\" IS NULL
  AND \\\"hrDecision\\\" IS NULL
  AND status IN ('WAITLIST', 'ACCEPTED', 'DISCOVERY_SCHEDULED')
  AND \\\"currentStep\\\" != 'INITIAL_TEST'
GROUP BY status, \\\"currentStep\\\";
\""
```

- [ ] **Step 2: Restore WAITLIST candidates with wrong currentStep**

```bash
ssh playphoto "docker exec playphoto_hr_bot-postgres-1 psql -U postgres -d playphoto_bot -c \"
UPDATE \\\"Candidate\\\"
SET status = 'WAITLIST',
    \\\"currentStep\\\" = 'INITIAL_TEST',
    \\\"isWaitlisted\\\" = true,
    \\\"materialsSent\\\" = false,
    \\\"materialsSentAt\\\" = NULL,
    \\\"notificationSent\\\" = false,
    \\\"statusChangedAt\\\" = NOW()
WHERE \\\"isOtherCity\\\" = true
  AND \\\"locationId\\\" IS NULL
  AND \\\"hrDecision\\\" IS NULL
  AND status = 'WAITLIST'
  AND \\\"currentStep\\\" = 'TRAINING';
\""
```

- [ ] **Step 3: Restore ACCEPTED candidates who were wrongly promoted from WAITLIST**

```bash
ssh playphoto "docker exec playphoto_hr_bot-postgres-1 psql -U postgres -d playphoto_bot -c \"
UPDATE \\\"Candidate\\\"
SET status = 'WAITLIST',
    \\\"currentStep\\\" = 'INITIAL_TEST',
    \\\"isWaitlisted\\\" = true,
    \\\"materialsSent\\\" = false,
    \\\"materialsSentAt\\\" = NULL,
    \\\"notificationSent\\\" = false,
    \\\"isWaitlisted\\\" = true,
    \\\"statusChangedAt\\\" = NOW()
WHERE \\\"isOtherCity\\\" = true
  AND \\\"locationId\\\" IS NULL
  AND \\\"hrDecision\\\" IS NULL
  AND status = 'ACCEPTED'
  AND \\\"currentStep\\\" = 'INITIAL_TEST';
\""
```

- [ ] **Step 4: Restore DISCOVERY_SCHEDULED candidates who were wrongly promoted**

```bash
ssh playphoto "docker exec playphoto_hr_bot-postgres-1 psql -U postgres -d playphoto_bot -c \"
UPDATE \\\"Candidate\\\"
SET status = 'WAITLIST',
    \\\"currentStep\\\" = 'INITIAL_TEST',
    \\\"isWaitlisted\\\" = true,
    \\\"materialsSent\\\" = false,
    \\\"materialsSentAt\\\" = NULL,
    \\\"notificationSent\\\" = false,
    \\\"discoverySlotId\\\" = NULL,
    \\\"statusChangedAt\\\" = NOW()
WHERE \\\"isOtherCity\\\" = true
  AND \\\"locationId\\\" IS NULL
  AND \\\"hrDecision\\\" IS NULL
  AND status = 'DISCOVERY_SCHEDULED';
\""
```

- [ ] **Step 5: Verify the fix**

```bash
ssh playphoto "docker exec playphoto_hr_bot-postgres-1 psql -U postgres -d playphoto_bot -c \"
SELECT \\\"fullName\\\", city, status, \\\"currentStep\\\", \\\"isWaitlisted\\\", \\\"materialsSent\\\", \\\"hrDecision\\\"
FROM \\\"Candidate\\\"
WHERE \\\"isOtherCity\\\" = true AND \\\"locationId\\\" IS NULL
AND status NOT IN ('REJECTED')
ORDER BY city;
\""
```

Expected: All should show `status=WAITLIST, currentStep=INITIAL_TEST, isWaitlisted=true, materialsSent=false`.

---

### Task 5: Run full test suite and verify

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 2: Run cycle check and menu ID check**

Run: `npm run check-cycles && npm run check-menu-ids`
Expected: No issues

- [ ] **Step 3: Commit Phase A complete**

All Phase A commits should already be done per-task. Run `git log --oneline -5` to verify.

---

## Phase B: Enum Split (WAITLIST_HR / WAITLIST_MENTOR)

### Task 6: Create Prisma migration for new enum values

**Files:**
- Modify: `prisma/schema.prisma` (CandidateStatus enum)
- Create: Migration via `npx prisma migrate dev`

- [ ] **Step 1: Add new enum values to schema.prisma**

In `prisma/schema.prisma`, inside `enum CandidateStatus`, add after `WAITLIST`:

```prisma
enum CandidateStatus {
  SCREENING
  WAITLIST
  WAITLIST_HR
  WAITLIST_MENTOR
  INTERVIEW_SCHEDULED
  ...
```

Keep `WAITLIST` for backward compatibility during transition.

- [ ] **Step 2: Create migration**

Run: `npx prisma migrate dev --name add_waitlist_hr_mentor_statuses`

Expected: Migration created successfully.

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(schema): add WAITLIST_HR and WAITLIST_MENTOR candidate statuses"
```

---

### Task 7: Migrate candidate screening to use WAITLIST_HR

**Files:**
- Modify: `src/modules/candidate/handlers/index.ts` (3 places)

- [ ] **Step 1: Update "other city" flow (line 315)**

In `src/modules/candidate/handlers/index.ts`, replace:

```typescript
        const status = isUnderage ? CandidateStatus.REJECTED : CandidateStatus.WAITLIST;
```

with:

```typescript
        const status = isUnderage ? CandidateStatus.REJECTED : CandidateStatus.WAITLIST_HR;
```

- [ ] **Step 2: Update "no vacancies" flow (line 137)**

In the `handleNoVacancies` function, replace:

```typescript
    const status = isUnderage ? CandidateStatus.REJECTED : CandidateStatus.WAITLIST;
```

with:

```typescript
    const status = isUnderage ? CandidateStatus.REJECTED : CandidateStatus.WAITLIST_HR;
```

- [ ] **Step 3: Update main screening flow (line 437)**

In the screening completion block, replace:

```typescript
            status = CandidateStatus.WAITLIST;
```

with:

```typescript
            status = CandidateStatus.WAITLIST_HR;
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/candidate/handlers/index.ts
git commit -m "feat(candidate): use WAITLIST_HR for new candidate screening"
```

---

### Task 8: Migrate booking handler to use WAITLIST_MENTOR

**Files:**
- Modify: `src/handlers/booking.ts:426-439`

- [ ] **Step 1: Update start_training_scheduling waitlist transition**

In `src/handlers/booking.ts`, in the `start_training_scheduling` handler, replace:

```typescript
            { status: CandidateStatus.WAITLIST, isWaitlisted: true, currentStep: FunnelStep.TRAINING }
```

with:

```typescript
            { status: CandidateStatus.WAITLIST_MENTOR, isWaitlisted: true, currentStep: FunnelStep.TRAINING }
```

- [ ] **Step 2: Update the status check in the handler (from Task 2)**

Update the `isWaitlistMentor` check:

```typescript
    const isWaitlistMentor = candidate.status === CandidateStatus.WAITLIST_MENTOR ||
        (candidate.status === CandidateStatus.WAITLIST && candidate.currentStep === FunnelStep.TRAINING);
```

- [ ] **Step 3: Update callback guard**

In the callback guard, update the WAITLIST check to also cover legacy:

```typescript
        // Block HR-waitlist candidates (no HR approval yet)
        if (candidate.status === CandidateStatus.WAITLIST_HR) {
            await ctx.answerCallbackQuery("⏳ Твоя заявка ще на розгляді у HR.");
            const { showCandidateStatus } = await import("../utils/candidate-ui.js");
            await showCandidateStatus(ctx, candidate);
            return;
        }
        if (candidate.status === CandidateStatus.WAITLIST && candidate.currentStep !== FunnelStep.TRAINING) {
            await ctx.answerCallbackQuery("⏳ Твоя заявка ще на розгляді у HR.");
            const { showCandidateStatus } = await import("../utils/candidate-ui.js");
            await showCandidateStatus(ctx, candidate);
            return;
        }
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/handlers/booking.ts
git commit -m "feat(booking): use WAITLIST_MENTOR for slot-unavailable transitions"
```

---

### Task 9: Migrate mentor service to use WAITLIST_MENTOR

**Files:**
- Modify: `src/services/mentor-service.ts`

- [ ] **Step 1: Update getWaitlistCount()**

Replace:

```typescript
    async getWaitlistCount() {
        return await prisma.candidate.count({
            where: {
                status: CandidateStatus.WAITLIST,
                isWaitlisted: true,
                currentStep: FunnelStep.TRAINING
            }
        });
    }
```

with:

```typescript
    async getWaitlistCount() {
        return await prisma.candidate.count({
            where: {
                status: { in: [CandidateStatus.WAITLIST_MENTOR, CandidateStatus.WAITLIST] },
                isWaitlisted: true,
                currentStep: FunnelStep.TRAINING
            }
        });
    }
```

- [ ] **Step 2: Update getCandidates(isWaitlist=true)**

Replace:

```typescript
            return await candidateRepository.findByStatusWithUser(CandidateStatus.WAITLIST, {
                isWaitlisted: true,
                currentStep: FunnelStep.TRAINING
            });
```

with:

```typescript
            return await candidateRepository.findByStatusWithUser(
                [CandidateStatus.WAITLIST_MENTOR, CandidateStatus.WAITLIST], {
                isWaitlisted: true,
                currentStep: FunnelStep.TRAINING
            });
```

- [ ] **Step 3: Update sendMaterials() status check**

In `sendMaterials()`, update the WAITLIST message branch:

```typescript
        if (cand.status === "WAITLIST" || cand.status === "WAITLIST_MENTOR") {
```

- [ ] **Step 4: Update notifyWaitlist()**

Replace the findByStatus call and filter:

```typescript
    async notifyWaitlist(api: any) {
        const mentorWaitlist = await candidateRepository.findByStatusWithUser(
            [CandidateStatus.WAITLIST_MENTOR, CandidateStatus.WAITLIST], {
            isWaitlisted: true,
            currentStep: FunnelStep.TRAINING,
            hrDecision: "ACCEPTED"
        });
```

And update the status set in the loop:

```typescript
                    await candidateRepository.update(cand.id, {
                        status: CandidateStatus.ACCEPTED,
                        isWaitlisted: false,
                        materialsSent: true,
                        materialsSentAt: new Date()
                    });
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/services/__tests__/mentor-service.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/mentor-service.ts
git commit -m "feat(mentor): use WAITLIST_MENTOR in mentor service queries"
```

---

### Task 10: Migrate HR service to use WAITLIST_HR

**Files:**
- Modify: `src/services/hr-service.ts`

- [ ] **Step 1: Update getWaitlistCandidates()**

Find the HR waitlist query and update to include both old and new values:

```typescript
    async getWaitlistCandidates() {
        return candidateRepository.findByStatusWithUser(
            [CandidateStatus.WAITLIST_HR, CandidateStatus.WAITLIST], {
            isWaitlisted: true,
            currentStep: { in: [FunnelStep.INITIAL_TEST, FunnelStep.INTERVIEW] }
        });
    },
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/hr-service.ts
git commit -m "feat(hr): use WAITLIST_HR in HR service queries"
```

---

### Task 11: Update candidate-ui.ts and other references

**Files:**
- Modify: `src/utils/candidate-ui.ts`
- Modify: `src/menus/mentor.ts`
- Modify: `src/handlers/admin/recruitment.ts`

- [ ] **Step 1: Update candidate-ui.ts WAITLIST case**

In `src/utils/candidate-ui.ts`, find the WAITLIST case and add WAITLIST_HR/WAITLIST_MENTOR:

```typescript
        case CandidateStatus.WAITLIST:
        case CandidateStatus.WAITLIST_HR:
        case CandidateStatus.WAITLIST_MENTOR: {
```

- [ ] **Step 2: Update mentor inbox details menu**

In `src/menus/mentor.ts`, update the condition (already modified in Task 3):

```typescript
    else if (cand.status === "ACCEPTED" || cand.status === "WAITLIST_MENTOR" ||
             (cand.status === "WAITLIST" && cand.currentStep === FunnelStep.TRAINING)) {
```

- [ ] **Step 3: Update recruitment.ts re-invite check**

In `src/handlers/admin/recruitment.ts`, find the WAITLIST check and update:

```typescript
    if (isMentor && ["TRAINING_COMPLETED", "WAITLIST", "WAITLIST_MENTOR"].includes(cand.status) && cand.quizScore !== null) {
```

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 5: Run cycle and menu ID checks**

Run: `npm run check-cycles && npm run check-menu-ids`
Expected: No issues

- [ ] **Step 6: Commit**

```bash
git add src/utils/candidate-ui.ts src/menus/mentor.ts src/handlers/admin/recruitment.ts
git commit -m "feat: update all WAITLIST references to support HR/MENTOR split"
```

---

### Task 12: Migrate existing data to new enum values

**Files:**
- SQL on production server

- [ ] **Step 1: Migrate HR waitlist candidates**

```bash
ssh playphoto "docker exec playphoto_hr_bot-postgres-1 psql -U postgres -d playphoto_bot -c \"
UPDATE \\\"Candidate\\\"
SET status = 'WAITLIST_HR',
    \\\"statusChangedAt\\\" = NOW()
WHERE status = 'WAITLIST'
  AND \\\"currentStep\\\" IN ('INITIAL_TEST', 'INTERVIEW');
\""
```

- [ ] **Step 2: Migrate mentor waitlist candidates**

```bash
ssh playphoto "docker exec playphoto_hr_bot-postgres-1 psql -U postgres -d playphoto_bot -c \"
UPDATE \\\"Candidate\\\"
SET status = 'WAITLIST_MENTOR',
    \\\"statusChangedAt\\\" = NOW()
WHERE status = 'WAITLIST'
  AND \\\"currentStep\\\" = 'TRAINING';
\""
```

- [ ] **Step 3: Verify no legacy WAITLIST remains (besides edge cases)**

```bash
ssh playphoto "docker exec playphoto_hr_bot-postgres-1 psql -U postgres -d playphoto_bot -c \"
SELECT count(*), status, \\\"currentStep\\\" FROM \\\"Candidate\\\"
WHERE status IN ('WAITLIST', 'WAITLIST_HR', 'WAITLIST_MENTOR')
GROUP BY status, \\\"currentStep\\\";
\""
```

Expected: Only `WAITLIST_HR` and `WAITLIST_MENTOR` rows.

---

### Task 13: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`

- [ ] **Step 2: Run all checks**

Run: `npm run check-cycles && npm run check-menu-ids`

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: No TypeScript errors.
