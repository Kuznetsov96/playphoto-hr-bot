# Task-assignment wizard alignment report

## Scope
Aligned behavior across the three task-assignment entry points — task-creation.ts (`tas_*`),
task-flow.ts (`task_*`), task-bulk.ts (`tbk_*`) — without restructuring or merging them.

## Divergence A — notification text/button
- Wording standardized on the task-creation.ts/task-bulk.ts phrasing ("✨ Нове завдання!... Бажаю
  успіхів! Ти впораєшся! 💖") over task-flow.ts's "📋 Нове завдання на {date}!" — it was already the
  majority (2 of 3 flows, byte-identical) and reads warmer/more personal, matching the staff tone
  guide (docs/tone-of-voice.md, enforced by staff-texts-tone.test.ts).
- Button standardized on `staff_hub_tasks_redirect` (task-flow.ts's choice) over the generic
  `staff_hub_nav` — it takes the photographer straight to her task list, which is strictly more
  useful after a "you have a new task" notification.
- Extracted to `src/utils/task-notification.ts` (`buildTaskNotificationText`,
  `TASK_NOTIFICATION_BUTTON_CALLBACK`, `taskNotificationButtonLabel`), backed by a new
  `STAFF_TEXTS["staff-task-notification"]` entry in `src/constants/staff-texts.ts` (Ukrainian,
  staff-facing, as required). Had to trim to exactly one emotional emoji (💖) to satisfy
  `staff-texts-tone.test.ts`'s "one emotional emoji per text" rule — dropped ✨/📋/📎 from the
  header and completion hint, kept 📅/⏰ as structural field markers.
- All three handlers now call this builder instead of inlining HTML.

## Divergence B — time validation
- Correct regex (`/^([01]?\d|2[0-3]):[0-5]\d$/`) extracted to `src/utils/task-time.ts`
  (`isValidTaskDeadlineTime`), used by all three flows. Rejects `99:99`/`5:77`/`24:00`, accepts
  `9:05`/`23:59`.

## Divergence C — error rendering destroys keyboard
- task-creation.ts and task-flow.ts now use `ctx.reply(...)` like task-bulk.ts, instead of
  `ScreenManager.renderScreen(ctx, text)` with no keyboard.
- New English admin-facing string `ADMIN_TEXTS["admin-task-err-bad-time"]` added to
  `src/constants/admin-texts.ts`, replacing the two inline Ukrainian error strings.

## Divergence D — bulk flow drops media types
- `handleBulkTaskContent` in task-bulk.ts now recognizes all 7 `TaskAttachmentItem["type"]` values
  (photo, document, video, voice, video_note, audio, animation), matching task-creation.ts and
  task-flow.ts. Extracted to an exported pure helper `extractBulkTaskMedia` for testability.

## New/shared files
- `src/utils/task-time.ts` — shared deadline-time validator.
- `src/utils/task-notification.ts` — shared notification text/button builder (imports only from
  `src/constants/`, no handler imports — avoids the handler↔shared-util cycle `check-cycles` guards
  against).
- `src/constants/staff-texts.ts` — added `staff-task-notification`, `staff-task-notification-btn-tasks`.
- `src/constants/admin-texts.ts` — added `admin-task-err-bad-time`.
- `task-bulk.ts` — added exported `extractBulkTaskMedia`.

## Tests added
- `src/utils/__tests__/task-time.test.ts` — regex accepts/rejects.
- `src/utils/__tests__/task-notification.test.ts` — identical output across flows, deadline/hint
  inclusion, button callback.
- `src/handlers/admin/__tests__/task-bulk-media.test.ts` — all 7 media types extracted correctly.

## Verification
`npm run build && npm run check-cycles && npm run check-menu-ids && npm run check-location-labels
&& npm test` — all green except the pre-existing environment-only failures (unset
APP_ENCRYPTION_KEY/BOT_TOKEN), which sit exactly at the documented baseline: 34 failed files / 95
failed tests, unchanged. 21 new tests added, all passing.

## Concurrent-edit note
Another agent edited `src/handlers/admin/task-bulk.ts` and `src/utils/task-helpers.ts` during this
work (renamed a helper to `getAllBulkTaskCities`, refactored `renderCitySelection`). Rebased on
their version rather than reverting; my edits (notification builder wiring, time regex, media
extraction) are unaffected by and compatible with their changes.
