import { describe, expect, it, vi } from "vitest";

vi.mock("../../config/callback-secret.js", () => ({ CALLBACK_SECRET: "x".repeat(32) }));
vi.mock("../../core/redis.js", () => ({ redis: { set: vi.fn(), get: vi.fn() } }));

const { ADMIN_TEXTS } = await import("../../constants/admin-texts.js");
const { STAFF_TEXTS } = await import("../../constants/staff-texts.js");
const { renderShootAlert } = await import("../shoot-alert-dispatcher.js");
const { renderDailySummary } = await import("../finance/daily-summary-message.js");
const { renderReviewCard } = await import("../training-review-card.js");
const { renderCandidateMessageForAdmin } = await import("../../utils/candidate-admin-message.js");
const { surnameAndName } = await import("../../utils/person-name.js");

const NAME = "Зубаль Діана Іванівна";
const SHORT = "Зубаль Діана";
const PATRONYMIC = "Іванівна";

/** Every notification the bot sends to the owner on its own initiative, rendered with sample data. */
const notifications: Record<string, string> = {
    "candidate message (setup)": renderCandidateMessageForAdmin({
        fullName: NAME, username: "diana", city: "Lviv", stage: "Setup", status: "STAGING_SETUP", text: "Добрий день!",
    }),
    "candidate message (recovery)": renderCandidateMessageForAdmin({
        fullName: NAME, username: null, city: null, stage: "HR", recovery: true, text: "Привіт",
    }),
    "mirror failed": ADMIN_TEXTS["admin-notif-mirror-failed"]({ who: "@diana", attachment: "voice", body: "Привіт" }),
    "waiting for HR": ADMIN_TEXTS["admin-notif-waiting-for-hr"]({ name: SHORT, slot: "30.10 · 15:00" }),
    "support call": ADMIN_TEXTS["support-thread-called-dm"]({ caller: "Olena", title: "Бланк · Lviv" }),
    "candidates greeted": ADMIN_TEXTS["admin-notif-birthday-greeted"]({ count: 3 }),
    "birthday in 3 days": ADMIN_TEXTS["admin-notif-birthday-3d"]({ names: `${SHORT} (@diana)` }),
    "birthday tomorrow": ADMIN_TEXTS["admin-notif-birthday-1d"]({ names: `${SHORT} (@diana)` }),
    "birthday today": ADMIN_TEXTS["admin-notif-birthday-today"]({ names: `${SHORT} (@diana)` }),
    "staff blocked": ADMIN_TEXTS["admin-notif-staff-blocked"]({ name: SHORT }),
    "staff blocked (offboarded)": ADMIN_TEXTS["admin-notif-staff-blocked-offboarded"]({ name: SHORT }),
    "shoot digest": renderShootAlert({
        publicId: "p", kind: "DAILY_DIGEST",
        payload: { openUrl: "https://x.example", items: [{ shootPublicId: "a", locationName: "Leoland", shootOn: "2030-03-10", startsAtLocalTime: "12:00", childName: "Марта" }] },
    } as never),
    "shoot eve": renderShootAlert({
        publicId: "p", kind: "EVE_OF_SHOOT",
        payload: { openUrl: "https://x.example", items: [{ shootPublicId: "a", locationName: "Leoland", shootOn: "2030-03-10", startsAtLocalTime: null, childName: null }] },
    } as never),
    "shoot late": renderShootAlert({
        publicId: "p", kind: "LATE_CREATED",
        payload: { openUrl: "https://x.example", items: [{ shootPublicId: "a", locationName: "Leoland", shootOn: "2030-03-10", startsAtLocalTime: "09:30", childName: null }] },
    } as never),
    "replacement confirmed": ADMIN_TEXTS["admin-replacement-confirmed"]({ requesterName: SHORT, candidateName: "Йорж Анна", location: "Leoland (Lviv)", date: "30.10", time: "15:00–21:00" }),
    "replacement needs review": ADMIN_TEXTS["admin-replacement-needs-review"]({ requesterName: SHORT, candidateName: "Йорж Анна", location: "Leoland (Lviv)", date: "30.10", time: "15:00–21:00" }),
    "replacement started": ADMIN_TEXTS["admin-notif-replacement-started"]({ who: SHORT, when: "30.10 · 15:00–21:00", where: "Leoland (Lviv)" }),
    "replacement found": ADMIN_TEXTS["admin-notif-replacement-found"]({ who: `${SHORT} → Йорж Анна`, when: "30.10 · 15:00–21:00", where: "Leoland (Lviv)" }),
    "replacement failed": ADMIN_TEXTS["admin-notif-replacement-failed"]({ who: SHORT, when: "30.10 · 15:00–21:00", where: "Leoland (Lviv)" }),
    "replacement cancelled": ADMIN_TEXTS["admin-notif-replacement-cancelled"]({ who: SHORT, when: "30.10 · 15:00–21:00", where: "Leoland (Lviv)" }),
    "pitch review": renderReviewCard({
        reviewPublicId: "5b0c3f5e-9a51-4c2b-9b7a-0c1f3e8d2a11", fileId: "f", attachmentKind: "VOICE", candidateName: NAME,
        locationName: "Drive City", scorePct: 86, attemptNo: 2, checklist: ["Greeting", "Photo"], reminder: true,
    }),
    "schedule sync stopped": ADMIN_TEXTS["admin-notif-schedule-stale"]({ minutes: 45, lastSync: "28.10 · 12:30" }),
    "funnel anomaly": ADMIN_TEXTS["admin-notif-funnel-anomaly"]({ count: 2, preview: `${SHORT} · MENTOR/STEP` }),
    "funnel spike": ADMIN_TEXTS["admin-notif-funnel-spike"]({ count: 6 }),
    "staging completed": ADMIN_TEXTS["admin-notif-staging-completed"]({ name: SHORT, location: "Leoland (Lviv)" }),
    "task overdue": ADMIN_TEXTS["admin-notif-task-overdue"]({ name: SHORT, task: "Count paper", deadline: "18:00" }),
    "ticket transferred": STAFF_TEXTS["support-info-transferred-dm"]({ urgent: false, ticketId: 12, name: SHORT, location: "Leoland (Lviv)" }),
    "ticket transferred (urgent)": STAFF_TEXTS["support-info-transferred-dm"]({ urgent: true, ticketId: 12, name: SHORT, location: "Leoland (Lviv)" }),
    "daily summary": renderDailySummary({
        totals: { salesTotal: 12000, cashTotal: 5000, terminalTotal: 7000 },
        locations: [{ publicId: "l", label: "Leoland", salesTotal: 12000, cashTotal: 5000, terminalTotal: 7000 }],
        overdue: [{ publicId: "o", label: "Drive City", openedAt: "2030-03-10T08:00:00Z" }],
        neverOpened: [{ publicId: "n", label: "Dragon Park" }],
    }, "2030-03-10"),
    "daily summary (unavailable)": renderDailySummary(null, "2030-03-10"),
};

const buttons = [
    ADMIN_TEXTS["admin-notif-btn-reply"],
    ADMIN_TEXTS["admin-notif-btn-open"],
    ADMIN_TEXTS["admin-notif-btn-view-decide"],
    ADMIN_TEXTS["admin-notif-btn-details"],
    ADMIN_TEXTS["admin-replacement-btn-revert"],
    ADMIN_TEXTS["support-thread-btn-open"],
    ADMIN_TEXTS["support-thread-btn-back"],
    ADMIN_TEXTS["support-btn-go-to-topic"],
    STAFF_TEXTS["support-btn-go-to-topic"],
];

describe("owner notifications share one format", () => {
    for (const [label, text] of Object.entries(notifications)) {
        it(`${label}: bold title first, no emoji`, () => {
            expect(text.startsWith("<b>")).toBe(true);
            expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
        });
    }

    it("buttons carry no emoji", () => {
        for (const label of buttons) expect(label).not.toMatch(/\p{Extended_Pictographic}/u);
    });

    it("never prints the patronymic", () => {
        for (const [label, text] of Object.entries(notifications)) {
            expect(text, label).not.toContain(PATRONYMIC);
        }
    });

    it("surnameAndName cuts a three-word name to two", () => {
        expect(surnameAndName(`  ${NAME} `)).toBe(SHORT);
        expect(surnameAndName("Зубаль")).toBe("Зубаль");
        expect(surnameAndName("")).toBe("");
    });

    it("escapes the candidate's text but keeps it as written", () => {
        const text = renderCandidateMessageForAdmin({
            fullName: "A <b> C", username: "u", city: "Lviv", stage: "HR", text: "1 < 2 & 3",
        });
        expect(text).toContain("1 &lt; 2 &amp; 3");
        expect(text).toContain("A &lt;b&gt;");
    });

    it("lists shoots one per line, date and time joined with a dot", () => {
        expect(notifications["shoot digest"]).toBe("<b>Shoots need a photographer</b>\n\n10.03 · 12:00 · Leoland · Марта");
        expect(notifications["shoot eve"]).toBe("<b>Shoot tomorrow needs a photographer</b>\n\n10.03 · Leoland");
    });
});
