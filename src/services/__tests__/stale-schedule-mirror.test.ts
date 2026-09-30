import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getJson = vi.fn();
const setJson = vi.fn();

vi.mock("../../repositories/system-state-repository.js", () => ({
    systemStateRepository: {
        getJson: (...a: unknown[]) => getJson(...a),
        setJson: (...a: unknown[]) => setJson(...a),
    },
}));

const { checkScheduleMirrorFreshness } = await import("../stale-schedule-mirror.js");

const NOW = new Date("2026-08-14T12:00:00.000Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

/** The sync's own record of when it last completed. */
const lastSync = (isoTime: string) => ({ generatedAt: isoTime });

beforeEach(() => {
    getJson.mockReset();
    setJson.mockReset().mockResolvedValue(undefined);
});

/**
 * The mirror is only useful while it keeps being refreshed. A sync that dies
 * leaves the bot serving yesterday's schedule with no error anywhere: the loop
 * catches its own failure into a log line, and the worse case — a timer that
 * simply stops firing — produces no log at all. This check watches the one thing
 * that proves the data is current: when the sync last finished.
 */
describe("checkScheduleMirrorFreshness", () => {
    it("stays silent while the sync is keeping up", async () => {
        getJson.mockResolvedValue(lastSync(minutesAgo(4)));

        const result = await checkScheduleMirrorFreshness({ now: NOW, alertedAt: null });

        expect(result).toEqual({ stale: false });
    });

    it("reports the mirror as stale once the sync has been silent too long", async () => {
        getJson.mockResolvedValue(lastSync(minutesAgo(45)));

        const result = await checkScheduleMirrorFreshness({ now: NOW, alertedAt: null });

        expect(result).toMatchObject({ stale: true, shouldNotify: true });
        expect((result as { staleForMinutes: number }).staleForMinutes).toBe(45);
    });

    /**
     * The anti-spam rule. A dead sync stays dead, and this check runs on a loop —
     * without this it would message the admin every single pass until someone
     * fixes it, which trains people to mute the bot.
     */
    it("notifies once and then stays quiet while the same outage continues", async () => {
        getJson.mockResolvedValue(lastSync(minutesAgo(45)));

        const first = await checkScheduleMirrorFreshness({ now: NOW, alertedAt: null });
        expect(first).toMatchObject({ shouldNotify: true });

        const second = await checkScheduleMirrorFreshness({
            now: new Date(NOW.getTime() + 10 * 60_000),
            alertedAt: NOW,
        });
        expect(second).toMatchObject({ stale: true, shouldNotify: false });
    });

    /**
     * A repeat is allowed, but only after a long gap — an outage still unfixed
     * hours later deserves one reminder, not silence forever.
     */
    it("reminds again only after a long gap", async () => {
        getJson.mockResolvedValue(lastSync(minutesAgo(300)));

        const result = await checkScheduleMirrorFreshness({
            now: NOW,
            alertedAt: new Date(NOW.getTime() - 7 * 60 * 60_000),
        });

        expect(result).toMatchObject({ stale: true, shouldNotify: true });
    });

    /**
     * Recovery must clear the memory of the outage, or the next real one would
     * be silently swallowed by the repeat-suppression window.
     */
    it("clears the alert state once the sync recovers", async () => {
        getJson.mockResolvedValue(lastSync(minutesAgo(2)));

        const result = await checkScheduleMirrorFreshness({ now: NOW, alertedAt: NOW });

        expect(result).toEqual({ stale: false, recovered: true });
    });

    /**
     * No record at all means the sync has not completed once since deploy. That
     * is worth knowing, but it is also the normal state for the first minutes of
     * a fresh container — so it is only reported past the same threshold.
     */
    it("treats a missing record as stale rather than as healthy", async () => {
        getJson.mockResolvedValue(null);

        const result = await checkScheduleMirrorFreshness({
            now: NOW,
            alertedAt: null,
            startedAt: new Date(NOW.getTime() - 45 * 60_000),
        });

        expect(result).toMatchObject({ stale: true });
    });

    it("gives a freshly started container time before complaining about a missing record", async () => {
        getJson.mockResolvedValue(null);

        const result = await checkScheduleMirrorFreshness({
            now: NOW,
            alertedAt: null,
            startedAt: new Date(NOW.getTime() - 3 * 60_000),
        });

        expect(result).toEqual({ stale: false });
    });

    /**
     * A malformed record must not be read as "fresh": that would hide exactly the
     * failure this check exists for.
     */
    it("does not treat an unreadable record as proof of freshness", async () => {
        getJson.mockResolvedValue({ generatedAt: "not-a-date" });

        const result = await checkScheduleMirrorFreshness({
            now: NOW,
            alertedAt: null,
            startedAt: new Date(NOW.getTime() - 45 * 60_000),
        });

        expect(result).toMatchObject({ stale: true });
    });
});

/**
 * Who the alert reaches and in what language is part of its contract: an alert
 * the owner cannot read, or that lands in a group nobody watches, is an alert
 * that does not exist.
 */
describe("startScheduleMirrorWatch — delivery", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function runWatchOnce(adminIds: number[]) {
        getJson.mockImplementation((key: string) =>
            Promise.resolve(
                key === "aws-business-sync:last" ? lastSync(minutesAgo(45)) : null,
            ));
        const sendMessage = vi.fn().mockResolvedValue(undefined);
        const { startScheduleMirrorWatch } = await import("../stale-schedule-mirror.js");

        const timer = startScheduleMirrorWatch({ sendMessage }, adminIds);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        clearInterval(timer);
        return sendMessage;
    }

    it("alerts the first admin id and nobody else", async () => {
        // ADMIN_IDS[0] is the owner by the convention the rest of the bot already
        // follows. Fanning an operational alert out to every admin trains all of
        // them to swipe it away.
        const sendMessage = await runWatchOnce([107794048, 222222222, 333333333]);

        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0]?.[0]).toBe(107794048);
    });

    it("writes the alert in English", async () => {
        // Admin-facing text is English by project rule; Ukrainian is for staff and
        // candidates. This one was written in Ukrainian and slipped the rule.
        const sendMessage = await runWatchOnce([107794048]);

        const text = String(sendMessage.mock.calls[0]?.[1] ?? "");
        expect(text).not.toMatch(/[а-яіїєґ]/iu);
        expect(text).toMatch(/schedule/i);
    });

    it("says how long it has been stale and as of when photographers are seeing data", async () => {
        // Without both numbers the alert says only "something is wrong", which
        // leaves the reader to go digging in logs before they can judge urgency.
        const sendMessage = await runWatchOnce([107794048]);

        const text = String(sendMessage.mock.calls[0]?.[1] ?? "");
        // 45 minutes stale when the watch was armed, plus the 10 the timer advanced.
        expect(text).toMatch(/55 min/);
        // 11:15 UTC rendered in Kyiv time, which is what the reader's clock shows.
        expect(text).toMatch(/14:15/);
        expect(text).not.toMatch(/\dT\d|Z\b/);
    });

    it("sends nothing at all while the sync is healthy", async () => {
        getJson.mockImplementation((key: string) =>
            Promise.resolve(
                key === "aws-business-sync:last" ? lastSync(minutesAgo(2)) : null,
            ));
        const sendMessage = vi.fn().mockResolvedValue(undefined);
        const { startScheduleMirrorWatch } = await import("../stale-schedule-mirror.js");

        const timer = startScheduleMirrorWatch({ sendMessage }, [107794048]);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        clearInterval(timer);

        expect(sendMessage).not.toHaveBeenCalled();
    });
});
