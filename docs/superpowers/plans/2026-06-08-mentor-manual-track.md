# Mentor Manual Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bot-driven self-scheduling mentor stage with a manual mentor track where the mentor contacts HR-approved candidates herself, while keeping the existing funnel intact for candidates already in it.

**Architecture:** Introduce a new `MENTOR_MANUAL` candidate status. HR-approved candidates enter it (instead of `ACCEPTED`). The mentor sees them in a new Inbox group with a card offering Message / Reply / Generate Channel Link / Accept / Reject. Accept reuses the existing NDA flow via a dedicated wrapper; Reject rejects + revokes channel access. The legacy discovery/training self-scheduling track is left untouched and only applies to candidates already on it.

**Tech Stack:** TypeScript ESM, grammY, Prisma/PostgreSQL, Vitest. Every `candidateRepository.update` passes through `candidate-funnel-guard.ts`, which throws on disallowed transitions — so the guard must accept all `MENTOR_MANUAL` transitions.

**Spec:** `docs/superpowers/specs/2026-06-08-mentor-manual-track-design.md`

---

## File Structure

- `prisma/schema.prisma` — add `MENTOR_MANUAL` enum value (+ generated migration).
- `src/services/candidate-funnel-guard.ts` — allow transitions into/out of `MENTOR_MANUAL`; map to TRAINING step; include in mentor-track/eligibility sets.
- `src/services/access-service.ts` — authorize `MENTOR_MANUAL` for channel access.
- `src/services/funnel-anomaly-detector.ts` — include `MENTOR_MANUAL` in mentor/final status set.
- `src/services/stats-service.ts` — include `MENTOR_MANUAL` where mentor statuses are counted.
- `src/services/worker.ts` — set entry status to `MENTOR_MANUAL` on HR-accept.
- `src/services/mentor-service.ts` — new methods: `getManualMentorCandidates`, `acceptManualMentor`, `rejectManualMentor`, `generateChannelLinkForMentor`.
- `src/menus/mentor.ts` — new Inbox group + card buttons for `MENTOR_MANUAL`.
- Tests: `src/services/__tests__/candidate-funnel-guard.test.ts`, `src/services/__tests__/access-service.test.ts`, new `src/services/__tests__/mentor-manual-track.test.ts`.

---

## Task 1: Add `MENTOR_MANUAL` status to schema

**Files:**
- Modify: `prisma/schema.prisma` (enum `CandidateStatus`, ~line 769-795)

- [ ] **Step 1: Add the enum value**

In `prisma/schema.prisma`, inside `enum CandidateStatus`, add `MENTOR_MANUAL` right after `BLOCKER` (before the "Refactored Final Step Pipeline" comment):

```prisma
  OFFLINE_STAGING
  AWAITING_FIRST_SHIFT
  BLOCKER
  MENTOR_MANUAL

  // Refactored Final Step Pipeline
  NDA
```

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --name add_mentor_manual_status`
Expected: a new migration directory under `prisma/migrations/` and `prisma generate` runs clean.

- [ ] **Step 3: Verify build sees the new enum member**

Run: `npx prisma generate && npm run build`
Expected: build passes, `CandidateStatus.MENTOR_MANUAL` is available.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add MENTOR_MANUAL candidate status"
```

---

## Task 2: Funnel guard — allow MENTOR_MANUAL transitions

**Files:**
- Modify: `src/services/candidate-funnel-guard.ts`
- Test: `src/services/__tests__/candidate-funnel-guard.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/services/__tests__/candidate-funnel-guard.test.ts` inside the `describe("candidate funnel guard", ...)` block:

```typescript
    it("allows entering MENTOR_MANUAL from interview completed with HR approval", () => {
        const oldState = makeCandidate({
            status: CandidateStatus.INTERVIEW_COMPLETED,
            currentStep: FunnelStep.INTERVIEW,
            hrDecision: "ACCEPTED",
            interviewCompletedAt: new Date("2026-04-01T10:00:00Z"),
        });
        const context = buildNextCandidateFunnelState(oldState, {
            status: CandidateStatus.MENTOR_MANUAL,
            currentStep: FunnelStep.TRAINING,
        });

        expect(() => validateCandidateFunnelTransition(context)).not.toThrow();
    });

    it("normalizes MENTOR_MANUAL into the training step", () => {
        const oldState = makeCandidate({
            status: CandidateStatus.INTERVIEW_COMPLETED,
            currentStep: FunnelStep.INTERVIEW,
            hrDecision: "ACCEPTED",
            interviewCompletedAt: new Date("2026-04-01T10:00:00Z"),
        });
        const normalized = normalizeCandidateFunnelPatch(oldState, {
            status: CandidateStatus.MENTOR_MANUAL,
        });

        expect((normalized as any).currentStep).toBe(FunnelStep.TRAINING);
    });

    it("allows MENTOR_MANUAL to advance to NDA", () => {
        const oldState = makeCandidate({
            status: CandidateStatus.MENTOR_MANUAL,
            currentStep: FunnelStep.TRAINING,
            hrDecision: "ACCEPTED",
            interviewCompletedAt: new Date("2026-04-01T10:00:00Z"),
        });
        const context = buildNextCandidateFunnelState(oldState, {
            status: CandidateStatus.NDA,
            currentStep: FunnelStep.TRAINING,
        });

        expect(() => validateCandidateFunnelTransition(context)).not.toThrow();
    });

    it("allows MENTOR_MANUAL to be rejected", () => {
        const oldState = makeCandidate({
            status: CandidateStatus.MENTOR_MANUAL,
            currentStep: FunnelStep.TRAINING,
            hrDecision: "ACCEPTED",
        });
        const context = buildNextCandidateFunnelState(oldState, {
            status: CandidateStatus.REJECTED,
        });

        expect(() => validateCandidateFunnelTransition(context)).not.toThrow();
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- candidate-funnel-guard`
Expected: the 4 new tests FAIL (transition `INTERVIEW_COMPLETED → MENTOR_MANUAL` and `MENTOR_MANUAL → NDA` not allowed; step mismatch).

- [ ] **Step 3: Add MENTOR_MANUAL to TRAINING_TRACK_STATUSES**

In `src/services/candidate-funnel-guard.ts`, add to the `TRAINING_TRACK_STATUSES` set (after `CandidateStatus.ACCEPTED`):

```typescript
const TRAINING_TRACK_STATUSES = new Set<CandidateStatus>([
    CandidateStatus.ACCEPTED,
    CandidateStatus.MENTOR_MANUAL,
    CandidateStatus.WAITLIST_MENTOR,
    CandidateStatus.DISCOVERY_SCHEDULED,
    CandidateStatus.DISCOVERY_COMPLETED,
    CandidateStatus.TRAINING_SCHEDULED,
    CandidateStatus.TRAINING_COMPLETED,
    CandidateStatus.NDA,
    CandidateStatus.KNOWLEDGE_TEST,
]);
```

- [ ] **Step 4: Include MENTOR_MANUAL in isMentorTrackState and isMentorEligible**

In `isMentorTrackState`, add `CandidateStatus.MENTOR_MANUAL` to the status array:

```typescript
function isMentorTrackState(state: CandidateFunnelSnapshot): boolean {
    return ([
        CandidateStatus.MENTOR_MANUAL,
        CandidateStatus.DISCOVERY_SCHEDULED,
        CandidateStatus.DISCOVERY_COMPLETED,
        CandidateStatus.TRAINING_SCHEDULED,
        CandidateStatus.TRAINING_COMPLETED,
        CandidateStatus.NDA,
        CandidateStatus.KNOWLEDGE_TEST,
        ...Array.from(FIRST_SHIFT_TRACK_STATUSES),
    ] as CandidateStatus[]).includes(state.status) ||
        Boolean(state.discoverySlotId) ||
        Boolean(state.trainingSlotId);
}
```

In `isMentorEligible`, add `CandidateStatus.MENTOR_MANUAL` to the status array (after `DISCOVERY_COMPLETED`):

```typescript
        ([
            CandidateStatus.MENTOR_MANUAL,
            CandidateStatus.DISCOVERY_COMPLETED,
            CandidateStatus.TRAINING_SCHEDULED,
            CandidateStatus.TRAINING_COMPLETED,
            CandidateStatus.NDA,
            CandidateStatus.KNOWLEDGE_TEST,
            CandidateStatus.STAGING_SETUP,
            CandidateStatus.STAGING_ACTIVE,
            CandidateStatus.OFFLINE_STAGING,
            CandidateStatus.READY_FOR_HIRE,
            CandidateStatus.AWAITING_FIRST_SHIFT,
            CandidateStatus.HIRED,
        ] as CandidateStatus[]).includes(state.status) ||
```

- [ ] **Step 5: Add allowsTransition cases**

In `allowsTransition`, add a `case` for `MENTOR_MANUAL` (place it before `case CandidateStatus.WAITLIST_MENTOR:`):

```typescript
        case CandidateStatus.MENTOR_MANUAL:
            return ([
                CandidateStatus.INTERVIEW_COMPLETED,
                CandidateStatus.DECISION_PENDING,
                CandidateStatus.ACCEPTED,
                CandidateStatus.MENTOR_MANUAL,
            ] as CandidateStatus[]).includes(oldState.status) || isLegacyMentorWaitlist(oldState);
```

And extend the `case CandidateStatus.NDA:` array to allow entry from `MENTOR_MANUAL`:

```typescript
        case CandidateStatus.NDA:
            return ([
                CandidateStatus.MENTOR_MANUAL,
                CandidateStatus.TRAINING_SCHEDULED,
                CandidateStatus.TRAINING_COMPLETED,
                CandidateStatus.NDA,
            ] as CandidateStatus[]).includes(oldState.status);
```

(`MENTOR_MANUAL → REJECTED` is already allowed by `case CandidateStatus.REJECTED: return true`. `requiredStepForStatus` returns `FunnelStep.TRAINING` automatically because `MENTOR_MANUAL` is now in `TRAINING_TRACK_STATUSES`, which also drives the `normalizeCandidateFunnelPatch` step backfill.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- candidate-funnel-guard`
Expected: all tests PASS (new and existing).

- [ ] **Step 7: Commit**

```bash
git add src/services/candidate-funnel-guard.ts src/services/__tests__/candidate-funnel-guard.test.ts
git commit -m "feat: allow MENTOR_MANUAL funnel transitions"
```

---

## Task 3: Authorize MENTOR_MANUAL for channel access

**Files:**
- Modify: `src/services/access-service.ts` (`isAuthorized`, ~line 72)
- Test: `src/services/__tests__/access-service.test.ts`

- [ ] **Step 1: Write failing test**

Append inside `describe("AccessService", ...)` in `src/services/__tests__/access-service.test.ts`:

```typescript
    it("authorizes candidates in the manual mentor track", async () => {
        const service = new AccessService();
        mocks.findWithProfilesByTelegramId.mockResolvedValueOnce({
            role: Role.CANDIDATE,
            candidate: { status: CandidateStatus.MENTOR_MANUAL },
        });

        await expect(service.isAuthorized(123n)).resolves.toBe(true);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- access-service`
Expected: new test FAILS (resolves to false).

- [ ] **Step 3: Add MENTOR_MANUAL to allowedStatuses**

In `src/services/access-service.ts`, in `isAuthorized`, add to the `allowedStatuses` array (after `CandidateStatus.ACCEPTED`):

```typescript
            const allowedStatuses: CandidateStatus[] = [
                CandidateStatus.ACCEPTED,
                CandidateStatus.MENTOR_MANUAL,
                CandidateStatus.DISCOVERY_SCHEDULED,
                CandidateStatus.DISCOVERY_COMPLETED,
                CandidateStatus.TRAINING_SCHEDULED,
                CandidateStatus.TRAINING_COMPLETED,
                CandidateStatus.NDA,
                CandidateStatus.KNOWLEDGE_TEST,
                CandidateStatus.STAGING_SETUP,
                CandidateStatus.STAGING_ACTIVE,
                CandidateStatus.READY_FOR_HIRE,
                CandidateStatus.AWAITING_FIRST_SHIFT,
                CandidateStatus.HIRED,
            ];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- access-service`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/access-service.ts src/services/__tests__/access-service.test.ts
git commit -m "feat: authorize MENTOR_MANUAL for channel access"
```

---

## Task 4: Include MENTOR_MANUAL in analytics/anomaly status sets

**Files:**
- Modify: `src/services/funnel-anomaly-detector.ts` (`MENTOR_OR_FINAL_STATUSES`, line 3-18)
- Modify: `src/services/stats-service.ts`

- [ ] **Step 1: Add to anomaly detector set**

In `src/services/funnel-anomaly-detector.ts`, add to `MENTOR_OR_FINAL_STATUSES` (after `CandidateStatus.ACCEPTED`):

```typescript
const MENTOR_OR_FINAL_STATUSES = new Set<CandidateStatus>([
    CandidateStatus.ACCEPTED,
    CandidateStatus.MENTOR_MANUAL,
    CandidateStatus.WAITLIST_MENTOR,
    CandidateStatus.DISCOVERY_SCHEDULED,
    CandidateStatus.DISCOVERY_COMPLETED,
    CandidateStatus.TRAINING_SCHEDULED,
    CandidateStatus.TRAINING_COMPLETED,
    CandidateStatus.NDA,
    CandidateStatus.KNOWLEDGE_TEST,
    CandidateStatus.STAGING_SETUP,
    CandidateStatus.STAGING_ACTIVE,
    CandidateStatus.OFFLINE_STAGING,
    CandidateStatus.READY_FOR_HIRE,
    CandidateStatus.AWAITING_FIRST_SHIFT,
    CandidateStatus.HIRED,
]);
```

- [ ] **Step 2: Find stats-service mentor status enumerations**

Run: `grep -n "DISCOVERY_SCHEDULED\|TRAINING_SCHEDULED\|FunnelStep.TRAINING\|CandidateStatus.ACCEPTED" src/services/stats-service.ts`
Expected: a list of locations enumerating mentor-stage statuses (e.g. around lines 228, 411, 459, 617).

- [ ] **Step 3: Add MENTOR_MANUAL alongside ACCEPTED in stats-service**

For each location found in Step 2 where mentor-stage statuses are listed for "in mentorship / post-HR" counting (the sets that already contain `ACCEPTED` and discovery/training statuses), add `CandidateStatus.MENTOR_MANUAL` next to `CandidateStatus.ACCEPTED`. Do NOT add it to interview-stage or HR-stage sets. Treat `MENTOR_MANUAL` exactly as `ACCEPTED` is treated for dashboard bucketing.

- [ ] **Step 4: Run build and full test suite**

Run: `npm run build && npm test`
Expected: build passes, all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/funnel-anomaly-detector.ts src/services/stats-service.ts
git commit -m "feat: track MENTOR_MANUAL in funnel analytics"
```

---

## Task 5: Mentor service — manual track methods

**Files:**
- Modify: `src/services/mentor-service.ts`
- Test: Create `src/services/__tests__/mentor-manual-track.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/services/__tests__/mentor-manual-track.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CandidateStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
    findById: vi.fn(),
    update: vi.fn(),
    findByStatusWithUser: vi.fn(),
    syncUserAccess: vi.fn(),
    createInviteLink: vi.fn(),
    audit: vi.fn(),
    sendMessage: vi.fn(),
}));

vi.mock("../../repositories/candidate-repository.js", () => ({
    candidateRepository: {
        findById: mocks.findById,
        update: mocks.update,
        findByStatusWithUser: mocks.findByStatusWithUser,
    },
}));
vi.mock("../access-service.js", () => ({
    accessService: {
        syncUserAccess: mocks.syncUserAccess,
        createInviteLink: mocks.createInviteLink,
        staticJoinLink: "https://t.me/+static",
    },
}));
vi.mock("../../core/audit-logger.js", () => ({ audit: mocks.audit }));
vi.mock("../../core/logger.js", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const api = { sendMessage: mocks.sendMessage } as any;

describe("mentor manual track", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.update.mockResolvedValue({});
        mocks.sendMessage.mockResolvedValue(undefined);
    });

    it("lists MENTOR_MANUAL candidates", async () => {
        const { mentorService } = await import("../mentor-service.js");
        mocks.findByStatusWithUser.mockResolvedValue([{ id: "c1" }]);

        const result = await mentorService.getManualMentorCandidates();

        expect(mocks.findByStatusWithUser).toHaveBeenCalledWith(CandidateStatus.MENTOR_MANUAL);
        expect(result).toEqual([{ id: "c1" }]);
    });

    it("accept advances candidate to NDA", async () => {
        const { mentorService } = await import("../mentor-service.js");
        mocks.findById.mockResolvedValue({
            id: "c1",
            fullName: "Anna",
            status: CandidateStatus.MENTOR_MANUAL,
            user: { telegramId: 555n },
            location: { name: "Smile" },
        });

        const res = await mentorService.acceptManualMentor(api, "c1");

        expect(mocks.update).toHaveBeenCalledWith("c1", expect.objectContaining({
            status: CandidateStatus.NDA,
        }));
        expect(mocks.sendMessage).toHaveBeenCalled();
        expect(res?.success).toBe(true);
    });

    it("reject sets REJECTED and revokes access", async () => {
        const { mentorService } = await import("../mentor-service.js");
        mocks.findById.mockResolvedValue({
            id: "c1",
            fullName: "Anna",
            status: CandidateStatus.MENTOR_MANUAL,
            user: { telegramId: 555n },
        });

        const res = await mentorService.rejectManualMentor(api, "c1");

        expect(mocks.update).toHaveBeenCalledWith("c1", expect.objectContaining({
            status: CandidateStatus.REJECTED,
        }));
        expect(mocks.syncUserAccess).toHaveBeenCalledWith(555n, expect.any(String));
        expect(res?.success).toBe(true);
    });

    it("generates a one-time channel link", async () => {
        const { mentorService } = await import("../mentor-service.js");
        mocks.findById.mockResolvedValue({ id: "c1", user: { telegramId: 555n } });
        mocks.createInviteLink.mockResolvedValue("https://t.me/+invite");

        const link = await mentorService.generateChannelLinkForMentor("c1");

        expect(mocks.createInviteLink).toHaveBeenCalledWith(555n);
        expect(link).toBe("https://t.me/+invite");
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
            event: "mentor_channel_link_generated",
        }));
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- mentor-manual-track`
Expected: FAIL — methods do not exist.

- [ ] **Step 3: Implement the methods**

In `src/services/mentor-service.ts`, add these methods inside the `MentorService` class (after `getOnboardingCandidates`):

```typescript
    async getManualMentorCandidates() {
        return await candidateRepository.findByStatusWithUser(CandidateStatus.MENTOR_MANUAL);
    }

    async acceptManualMentor(api: Api, candId: string) {
        const cand = await candidateRepository.findById(candId);
        if (!cand) return null;

        await candidateRepository.update(candId, {
            status: CandidateStatus.NDA,
            trainingCompletedAt: new Date(),
            currentStep: FunnelStep.TRAINING,
            ndaSentAt: new Date(),
        });

        const firstName = extractFirstName(cand.fullName || "");
        const staticInfo = getLocationDetails(cand.location?.name);
        const jobDetails = `\n\n📍 <b>${cand.location?.name || cand.city}</b>\n` +
            `🏠 ${staticInfo?.address || cand.location?.address || ""}\n` +
            `📅 ${staticInfo?.schedule || cand.location?.schedule || "Пн-Пт 15:00-21:00"}\n` +
            `💰 ${staticInfo?.salary || cand.location?.salary || "25%"}`;

        const kb = new InlineKeyboard().text("✅ Ознайомлена з NDA", buildSignedCallback("cnda", cand.id));
        if (cand.user) {
            try {
                await api.sendMessage(Number(cand.user.telegramId),
                    CANDIDATE_TEXTS["nda-request"](firstName, NDA_LINK, jobDetails),
                    { parse_mode: "HTML", reply_markup: kb }
                );
            } catch (err: any) {
                if (isBotBlocked(err)) {
                    await handleBlockedCandidate(api, cand.id, cand.fullName || "Candidate");
                } else {
                    logger.error({ err, candidateId: cand.id }, "Failed to send NDA after manual mentor accept");
                    const mainAdmin = ADMIN_IDS[0];
                    if (mainAdmin) {
                        api.sendMessage(mainAdmin,
                            `⚠️ <b>NDA не доставлено!</b>\n\n👤 ${cand.fullName}\n📱 TG: ${cand.user.telegramId}\n\nСтатус змінено на NDA, але кандидатка не отримала кнопку.`,
                            { parse_mode: "HTML" }
                        ).catch(() => { });
                    }
                }
            }
        }

        audit({
            event: "candidate_manual_mentor_accepted",
            result: "success",
            actorType: "admin",
            telegramId: cand.user?.telegramId,
            entityType: "candidate",
            entityId: cand.id,
            context: { fromStatus: cand.status, toStatus: CandidateStatus.NDA },
        });

        if (cand.user) {
            await accessService.syncUserAccess(cand.user.telegramId, "Manual mentor accept");
        }
        return { candidate: cand, success: true };
    }

    async rejectManualMentor(api: Api, candId: string) {
        const cand = await candidateRepository.findById(candId);
        if (!cand) return null;

        await candidateRepository.update(candId, { status: CandidateStatus.REJECTED });

        audit({
            event: "candidate_manual_mentor_rejected",
            result: "success",
            actorType: "admin",
            telegramId: cand.user?.telegramId,
            entityType: "candidate",
            entityId: cand.id,
            context: { fromStatus: cand.status, toStatus: CandidateStatus.REJECTED },
        });

        if (cand.user) {
            await accessService.syncUserAccess(cand.user.telegramId, "Manual mentor reject");
        }
        return { candidate: cand, success: true };
    }

    async generateChannelLinkForMentor(candId: string) {
        const cand = await candidateRepository.findById(candId);
        if (!cand?.user) return null;

        const link = await accessService.createInviteLink(cand.user.telegramId);

        audit({
            event: "mentor_channel_link_generated",
            result: link ? "success" : "failed",
            actorType: "admin",
            telegramId: cand.user.telegramId,
            entityType: "candidate",
            entityId: cand.id,
            context: { status: cand.status, generated: Boolean(link) },
        });

        return link;
    }
```

(All imports used — `Api`, `CandidateStatus`, `FunnelStep`, `InlineKeyboard`, `extractFirstName`, `getLocationDetails`, `buildSignedCallback`, `CANDIDATE_TEXTS`, `NDA_LINK`, `ADMIN_IDS`, `isBotBlocked`, `handleBlockedCandidate`, `audit`, `accessService`, `logger` — are already imported at the top of `mentor-service.ts`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- mentor-manual-track`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/mentor-service.ts src/services/__tests__/mentor-manual-track.test.ts
git commit -m "feat: add mentor manual track service methods"
```

---

## Task 6: Worker — enter MENTOR_MANUAL on HR accept

**Files:**
- Modify: `src/services/worker.ts` (HR-decision ACCEPTED branch, ~line 71-74)

- [ ] **Step 1: Change the entry status**

In `src/services/worker.ts`, in the `decision === "ACCEPTED"` branch, change the status set on the candidate from `ACCEPTED` to `MENTOR_MANUAL`:

```typescript
                            await candidateRepository.update(cand.id, {
                                status: CandidateStatus.MENTOR_MANUAL,
                                notificationSent: true
                            });
```

Leave the handoff message (`worker-offer-accepted` + `contact_mentor` button) and the `notifyMentors(bot.api, cand)` call unchanged.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: passes.

- [ ] **Step 3: Run full suite (regression)**

Run: `npm test`
Expected: all green — existing worker/decision tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/services/worker.ts
git commit -m "feat: HR-approved candidates enter MENTOR_MANUAL track"
```

---

## Task 7: Mentor UI — Inbox group and card buttons

**Files:**
- Modify: `src/menus/mentor.ts`

- [ ] **Step 1: Add a "Manual" group to the Inbox**

In `src/menus/mentor.ts`, in `mentorInboxMenu.dynamic` (the non-waitlist branch, after the `candidates` action-needed loop and before `📢 Broadcast Materials`), add a section listing manual-track candidates:

```typescript
        const manualCandidates = await mentorService.getManualMentorCandidates();
        if (manualCandidates.length > 0) {
            range.text("👨‍🏫 Manual ——").row();
            for (const cand of manualCandidates) {
                const label = `👨‍🏫 ${formatCompactName(cand.fullName || "Cand")} • [${getCityCode(cand.city)}] ${getShortLocationName(cand.location?.name, cand.city)}`;
                range.text(label, async (ctx) => {
                    ctx.session.selectedCandidateId = cand.id;
                    const text = await getMentorCandidateProfileText(ctx, cand.id);
                    await ScreenManager.renderScreen(ctx, text, "mentor-inbox-details", { pushToStack: true });
                }).row();
            }
        }
```

- [ ] **Step 2: Add card buttons for MENTOR_MANUAL**

In `mentorInboxDetailsMenu.dynamic`, add a branch for the manual status. Place it before the existing `else if (cand.status === "ACCEPTED" ...)` branch:

```typescript
    if (cand.status === "MENTOR_MANUAL") {
        const username = cand.user?.username;
        if (username) {
            range.url("💬 Message", `https://t.me/${username}`).row();
        }
        range.text("🔗 Generate Channel Link", async (ctx) => {
            const link = await mentorService.generateChannelLinkForMentor(cand.id);
            if (link) {
                await ctx.reply(`🔗 One-time channel invite link for <b>${cand.fullName}</b>:\n${link}`, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
                await ctx.answerCallbackQuery("Link generated ✅");
            } else {
                await ctx.answerCallbackQuery("⚠️ Could not generate link — check candidate status");
            }
        }).row();
        range.text("✅ Accept (training passed)", async (ctx) => {
            await ctx.answerCallbackQuery();
            await mentorService.acceptManualMentor(ctx.api, cand.id);
            await ScreenManager.renderScreen(ctx, `✅ <b>${cand.fullName} accepted.</b>\nNDA request sent.`, "mentor-action-success");
        }).text("❌ Reject", async (ctx) => {
            await ctx.answerCallbackQuery();
            await mentorService.rejectManualMentor(ctx.api, cand.id);
            await ScreenManager.renderScreen(ctx, `❌ <b>${cand.fullName} rejected.</b>\nChannel access revoked.`, "mentor-action-success");
        }).row();
    }
```

The existing `✍️ Reply` button (guarded by `cand.status !== "TRAINING_COMPLETED"`) already covers `MENTOR_MANUAL`, so the mentor gets a bot-reply fallback automatically. `getCandidateDetails` already has a `statusMap`; add a label for the new status so the card header reads cleanly — in `mentor-service.ts` `getCandidateDetails`, add to `statusMap`:

```typescript
            "MENTOR_MANUAL": "👨‍🏫 Manual mentoring",
```

- [ ] **Step 3: Build and menu-id check**

Run: `npm run build && npm run check-menu-ids && npm run check-cycles`
Expected: all pass (no new dedicated menus added; buttons live in existing dynamic menus).

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/menus/mentor.ts src/services/mentor-service.ts
git commit -m "feat: mentor manual-track inbox group and card actions"
```

---

## Task 8: Final verification

- [ ] **Step 1: Run all gates**

Run: `npm run build && npm run check-cycles && npm run check-menu-ids && npm test`
Expected: all pass.

- [ ] **Step 2: Manual smoke (optional, via /run or staging)**

Confirm: a freshly HR-approved candidate appears in Mentor Inbox under "Manual"; card shows Message/Generate Link/Accept/Reject; Accept sends NDA; Reject revokes access. Verify a candidate already on DISCOVERY_SCHEDULED still shows the old discovery buttons (legacy track intact).

- [ ] **Step 3: Confirm no direct-to-main**

Ensure all commits are on `dev`. Deploy happens later via PR `dev → main` (use the `deploy` skill / open a PR when ready).

---

## Notes

- **No data migration.** Only candidates HR-approved after deploy get `MENTOR_MANUAL`. Existing DISCOVERY_*/TRAINING_* candidates keep the legacy buttons and slot self-scheduling.
- **Legacy track untouched.** `sendMaterials`, `completeDiscovery`, `completeTraining`, `start_training_scheduling`, Discovery/Training slot menus remain functional.
- **Candidate-facing texts** stay Ukrainian (NDA request, handoff). Mentor buttons are English per AGENTS.md.
