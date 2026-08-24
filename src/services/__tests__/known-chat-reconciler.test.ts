import { beforeEach, describe, expect, it, vi } from 'vitest';

const listActive = vi.fn();
const recordPresent = vi.fn();
const recordLost = vi.fn();
const locationFindMany = vi.fn();

vi.mock('../../repositories/known-chat-repository.js', () => ({
  knownChatRepository: { listActive, recordPresent, recordLost },
}));
vi.mock('../../db/core.js', () => ({
  default: { location: { findMany: locationFindMany } },
}));
vi.mock('../../core/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../core/log-events.js', () => ({
  logBusinessEvent: vi.fn(),
  logSecurityEvent: vi.fn(),
}));
// TEAM_CHATS.* are `parseInt(env.X)` — real in this worktree's .env, so a test run against
// the actual config would leak live chat ids into the seed set. Pinned here so the tests
// control exactly what enters seeding, including the NaN case from an unset env var.
vi.mock('../../config.js', () => ({
  TEAM_CHATS: { HUB: -300, SUPPORT: -301, CHANNEL: -302 },
}));

const { reconcileKnownChats } = await import('../known-chat-reconciler.js');

beforeEach(() => {
  vi.clearAllMocks();
  locationFindMany.mockResolvedValue([]);
});

function api(overrides: Record<string, unknown> = {}) {
  return {
    getMe: vi.fn().mockResolvedValue({ id: 999 }),
    getChat: vi.fn().mockResolvedValue({ id: -100, title: 'Fantasy Town', type: 'supergroup' }),
    getChatMember: vi.fn().mockResolvedValue({ status: 'administrator' }),
    ...overrides,
  } as never;
}

describe('reconcileKnownChats', () => {
  it('keeps a chat where the bot is still administrator', async () => {
    listActive.mockResolvedValue([{ id: -100n, title: 'Fantasy Town' }]);

    const result = await reconcileKnownChats(api());

    // Plus the 3 static TEAM_CHATS seeds, which are discovered on every sweep.
    expect(result.confirmed).toBe(1);
    expect(result.discovered).toBe(3);
    expect(recordLost).not.toHaveBeenCalled();
  });

  /**
   * Telegram drops `my_chat_member` for a bot that was offline more than a day, so a chat the
   * bot was removed from while down would otherwise stay in the registry forever.
   */
  it('marks a chat lost when the bot is no longer there', async () => {
    listActive.mockResolvedValue([{ id: -100n, title: 'Fantasy Town' }]);
    const failing = api({ getChatMember: vi.fn().mockRejectedValue(new Error('chat not found')) });

    const result = await reconcileKnownChats(failing);

    expect(recordLost).toHaveBeenCalledWith(-100n);
    // The registry chat fails; the 3 TEAM_CHATS seeds share the same mocked getChatMember
    // and fail too, since `failing` rejects unconditionally for every chat id.
    expect(result.lost).toBe(4);
  });

  /**
   * Without `can_restrict_members` the bot can neither check presence nor ban, so the chat is
   * useless for revocation and must be visible as a problem rather than silently skipped.
   */
  it('marks a chat lost when the bot was demoted to a plain member', async () => {
    listActive.mockResolvedValue([{ id: -100n, title: 'Fantasy Town' }]);
    const demoted = api({ getChatMember: vi.fn().mockResolvedValue({ status: 'member' }) });

    await reconcileKnownChats(demoted);

    expect(recordLost).toHaveBeenCalledWith(-100n);
  });

  /** First run: the registry is empty and the known ids seed it. */
  it('seeds the registry from existing location chats', async () => {
    listActive.mockResolvedValue([]);
    locationFindMany.mockResolvedValue([{ telegramChatId: -200n }]);

    const result = await reconcileKnownChats(api());

    expect(recordPresent).toHaveBeenCalledWith(expect.objectContaining({ id: -200n }));
    expect(result.discovered).toBeGreaterThan(0);
  });

  /** One unreachable chat must not abort the sweep for the rest. */
  it('keeps going when one chat throws', async () => {
    listActive.mockResolvedValue([{ id: -100n, title: 'A' }]);
    const flaky = api({
      getChatMember: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue({ status: 'administrator' }),
    });

    const result = await reconcileKnownChats(flaky);

    // -100 fails (first call); the 3 TEAM_CHATS seeds succeed (subsequent calls).
    expect(result.lost).toBe(1);
    expect(result.discovered).toBe(3);
  });

  /**
   * Ruling 3: seeding is not gated on an empty registry. A location chat added after the
   * first run must still be picked up, or it would silently never enter the registry.
   */
  it('seeds a new location chat even when the registry already has entries', async () => {
    listActive.mockResolvedValue([{ id: -100n, title: 'Fantasy Town' }]);
    locationFindMany.mockResolvedValue([{ telegramChatId: -200n }]);

    const result = await reconcileKnownChats(api());

    expect(recordPresent).toHaveBeenCalledWith(expect.objectContaining({ id: -200n }));
    // -200 from the location plus the 3 static TEAM_CHATS seeds.
    expect(result.discovered).toBe(4);
    expect(result.confirmed).toBe(1);
  });

  /**
   * Ruling 4: a chat that appears in both the registry and the seed sources must be swept
   * once, not twice — otherwise the counts double-count and getChatMember is called twice.
   */
  it('does not sweep the same chat twice when it is both known and a seed source', async () => {
    listActive.mockResolvedValue([{ id: -200n, title: 'Fantasy Town' }]);
    locationFindMany.mockResolvedValue([{ telegramChatId: -200n }]);
    const spy = api();

    const result = await reconcileKnownChats(spy);

    // -200 (registry+seed, deduped to one sweep) + the 3 static TEAM_CHATS seeds = 4 calls.
    expect((spy as { getChatMember: ReturnType<typeof vi.fn> }).getChatMember).toHaveBeenCalledTimes(4);
    expect(result.confirmed).toBe(1);
    expect(result.discovered).toBe(3);
  });

  /** Ruling 2: Location.telegramChatId is nullable; a null must never reach BigInt/getChatMember. */
  it('ignores locations without a telegramChatId', async () => {
    listActive.mockResolvedValue([]);
    locationFindMany.mockResolvedValue([{ telegramChatId: null }]);
    const spy = api();

    const result = await reconcileKnownChats(spy);

    // Only the 3 static TEAM_CHATS seeds; the null location must not add a 4th.
    expect(result.discovered).toBe(3);
    expect((spy as { getChatMember: ReturnType<typeof vi.fn> }).getChatMember).toHaveBeenCalledTimes(3);
  });

  /**
   * A seed chat (never in the registry) that turns out unreachable has no row to mark
   * lost — `recordLost` does a Prisma `update`, which throws on a row that was never
   * created. It must still count toward `lost` for visibility, just without the doomed
   * repository call.
   */
  it('counts an unreachable seed chat as lost without calling recordLost for it', async () => {
    listActive.mockResolvedValue([]);
    locationFindMany.mockResolvedValue([{ telegramChatId: -200n }]);
    const unreachable = api({ getChatMember: vi.fn().mockRejectedValue(new Error('chat not found')) });

    const result = await reconcileKnownChats(unreachable);

    // -200 plus the 3 static TEAM_CHATS seeds, all unreachable.
    expect(result.lost).toBe(4);
    expect(recordLost).not.toHaveBeenCalled();
  });

  /** getMe is called once per sweep, not once per chat. */
  it('calls getMe only once regardless of how many chats are swept', async () => {
    listActive.mockResolvedValue([
      { id: -100n, title: 'A' },
      { id: -101n, title: 'B' },
    ]);
    const spy = api();

    await reconcileKnownChats(spy);

    expect((spy as { getMe: ReturnType<typeof vi.fn> }).getMe).toHaveBeenCalledTimes(1);
  });
});
