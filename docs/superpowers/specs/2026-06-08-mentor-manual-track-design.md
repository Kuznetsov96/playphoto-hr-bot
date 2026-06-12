# Mentor Manual Track — Design Spec

**Date:** 2026-06-08
**Status:** Approved (design); implementation not started.

## Problem

Conversion drops after the HR interview stage. Once a candidate is HR-approved and handed
off to the mentor, the bot pushes the candidate to **self-schedule** a discovery/training
slot ("Обрати час"). Candidates frequently don't pick a time and go silent. The earlier,
manual approach — where the mentor personally reached out — produced better engagement.

## Goal

Replace the **mentorship portion** of the funnel with a simple manual track:

- The HR funnel stays exactly as it is.
- After HR approval, the candidate enters a new manual mentor stage. The bot still sends the
  existing handoff message ("наставник зв'яжеться" + "Написати наставнику"). No automatic
  self-scheduling button.
- The mentor sees a simple list of these candidates. Each candidate has a profile card with
  the info the mentor needs, plus action buttons. The mentor contacts candidates manually
  from her own Telegram profile, schedules meetings/training herself, and runs the conversation.
- On **Accept** (treated as "online training passed"), the candidate continues down the
  **existing** NDA flow exactly as today (status → NDA → NDA request → onboarding → first shift).
- On **Reject**, the candidate is rejected and loses channel access.

**Hard constraint:** do not break the existing flow for candidates already in the funnel.

## Key Decisions (from brainstorming)

1. **Remove the entire auto-materials + self-scheduling step** for the new track (no
   "Send Materials" / "Обрати час" / Discovery+Training slot self-booking).
2. The mentor does **not** split discovery vs. online training — it is one manual stage she
   runs in private chat.
3. **Accept** = "online training passed" → runs the existing NDA flow (same effect as today's
   `completeTraining('passed')`), via a dedicated wrapper method (variant b).
4. **Reject** = `status=REJECTED` + revoke channel access. No separate "remove access" button —
   reject is the only thing that revokes; we never revoke without rejecting.
5. **Generate Channel Link** button creates a one-time invite link; the mentor forwards it to
   the candidate manually.
6. New track applies **only to new candidates** (those who pass HR after deploy). Candidates
   already on DISCOVERY_*/TRAINING_* statuses continue on the old path untouched. **No data
   migration.**
7. Mentor buttons and texts are in **English** (per AGENTS.md: admin UI English; candidate-facing
   text stays Ukrainian). Candidate-facing NDA/handoff messages are unchanged.
8. **Log everything** (enter track, link generation, accept, reject) for auditability.

## New Status

Add `MENTOR_MANUAL` to `enum CandidateStatus` in `prisma/schema.prisma` + a generated migration.

This is a clean marker for "in manual mentor handling" that does not overlap with the legacy
DISCOVERY_*/TRAINING_* statuses, so old and new tracks coexist without interference.

`MENTOR_MANUAL` maps to `FunnelStep.TRAINING` (it is the mentor/training stage of the funnel).

## Flow

```
HR approves (hrDecision = ACCEPTED)
        │
        ▼
worker.ts processes decision (≈6h delay) — UNCHANGED message
   • sends "worker-offer-accepted" ("наставник зв'яжеться") + "Написати наставнику" (contact_mentor)
   • sets status = MENTOR_MANUAL  (was: ACCEPTED)
        │
        ▼
Mentor Hub → Inbox → new "Manual" group lists MENTOR_MANUAL candidates
        │
        ▼
Candidate card (English buttons):
   💬 Message            → t.me/<username> (mentor's own profile)
   ✍️ Reply              → existing bot reply flow (admin_reply_), fallback if no username
   🔗 Generate Channel Link → accessService.createInviteLink → show one-time link to mentor
   ✅ Accept (training passed) → acceptManualMentor(): status=NDA + NDA request → existing tail
   ❌ Reject              → rejectManualMentor(): status=REJECTED + revoke channel access
```

The legacy mentor track (`sendMaterials`, `completeDiscovery`, `start_training_scheduling`,
Discovery/Training slots, waitlist) is **not removed** — it keeps working for candidates already
in the funnel.

## Components / Integration Points (verified against code)

### Prisma
- `schema.prisma`: add `MENTOR_MANUAL` to `CandidateStatus` enum + migration.

### Entry / access
- `services/worker.ts` (HR-decision `ACCEPTED` branch): set `status = MENTOR_MANUAL` instead of
  `ACCEPTED`. Handoff message unchanged. Any manual HR-accept entry point set to the same status.
- `services/access-service.ts` (`isAuthorized`, ~line 72): add `MENTOR_MANUAL` to
  `allowedStatuses`. **Critical** — otherwise the auto-revoke loop bans the candidate and
  `createInviteLink` returns null.

### Funnel guard (`services/candidate-funnel-guard.ts`) — critical, throws on invalid transitions
- `allowsTransition`: allow `INTERVIEW_COMPLETED`/`DECISION_PENDING` → `MENTOR_MANUAL`; allow
  `MENTOR_MANUAL` → `NDA` (Accept). `MENTOR_MANUAL` → `REJECTED` is already covered
  (`case REJECTED: return true`).
- `requiredStepForStatus` + `TRAINING_TRACK_STATUSES`: add `MENTOR_MANUAL` → `FunnelStep.TRAINING`.
- `isMentorTrackState` / `isMentorEligible`: include `MENTOR_MANUAL` so the state is internally
  consistent. (Eligibility already holds via `hrDecision === "ACCEPTED"`.)

### Analytics / anomaly detection
- `services/funnel-anomaly-detector.ts`: add `MENTOR_MANUAL` to `MENTOR_OR_FINAL_STATUSES`.
  Since entry always follows HR approval (`hrDecision === "ACCEPTED"`), `lacksHrApprovalEvidence`
  is false, so it will not be flagged as an impossible state.
- `services/stats-service.ts`: include `MENTOR_MANUAL` where mentor statuses are enumerated for
  dashboards/counts.

### UI (`menus/mentor.ts`, `handlers/admin/recruitment.ts`)
- New "Manual" group in the Mentor Inbox listing `MENTOR_MANUAL` candidates (name • [city] location
  • age since entry).
- Candidate card with English buttons: 💬 Message, ✍️ Reply, 🔗 Generate Channel Link,
  ✅ Accept (training passed), ❌ Reject.
- 💬 Message hidden when no username (existing pattern in `mentorOnboardingDetailsMenu`).

### Service (`services/mentor-service.ts`)
- `getManualMentorCandidates()` — list by `status = MENTOR_MANUAL`.
- `acceptManualMentor(candId)` — variant (b): dedicated method that sets `status = NDA`, sends the
  NDA request (logic mirroring `completeTraining('passed')`), with its own audit log. Does **not**
  reuse `completeTraining` to avoid legacy side effects.
- `rejectManualMentor(candId)` — `status = REJECTED` + `syncUserAccess`/`revokeAccess`.
- `generateChannelLinkForMentor(candId)` — `createInviteLink` + log `mentor_channel_link_generated`.

### Logging
Use existing `audit()` / `logBusinessEvent` / `UserTimelineEvent` for: enter track, link generation,
accept, reject.

## Error Handling / Edge Cases

- **No username** → 💬 Message button hidden; ✍️ Reply remains.
- **createInviteLink returns null** → show mentor a warning ("candidate not authorized — check
  status"); do not crash. (Should not happen once `MENTOR_MANUAL` is authorized.)
- **Bot blocked by candidate** → existing `handleBlockedCandidate` (Accept sends NDA via api, which
  already handles blocked users).
- **Reject of an already-rejected candidate** → idempotent (`revokeInFlight` guard in access-service).
- **Funnel guard** → all `MENTOR_MANUAL` transitions explicitly allowed (see above) so updates do
  not throw.

## Testing

- **Unit:**
  - `isAuthorized(MENTOR_MANUAL)` → true (extend `access-service.test.ts`).
  - Entry sets `status = MENTOR_MANUAL`.
  - `acceptManualMentor` → `status = NDA` + NDA request sent.
  - `rejectManualMentor` → `status = REJECTED` + revoke invoked.
  - `generateChannelLinkForMentor` → `createInviteLink` invoked + logged.
  - Funnel guard: `INTERVIEW_COMPLETED → MENTOR_MANUAL`, `MENTOR_MANUAL → NDA`,
    `MENTOR_MANUAL → REJECTED` all allowed; `MENTOR_MANUAL` not flagged as anomaly
    (extend `candidate-funnel-guard.test.ts`).
- **Regression:** existing old-track tests (booking, discovery) stay green — proof the legacy flow
  is intact.
- **Gates before PR:** `npm run build`, `npm run check-cycles`, `npm run check-menu-ids`, `npm test`.

## Out of Scope

- Migrating candidates already in the funnel.
- Changing the HR funnel.
- Changing the NDA → onboarding → first-shift tail.
- Removing the legacy mentor track code.
