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
// Mirrors the real shape when TEAM_HUB_CHAT_ID / SUPPORT_CHAT_ID / TEAM_CHANNEL_ID are unset:
// `parseInt(undefined)` is NaN. This is a separate file (rather than a case in
// known-chat-reconciler.test.ts) because vi.mock is hoisted per module graph — this file's
// TEAM_CHATS mock must differ from the other file's, and only a fresh module registry keeps
// the two from colliding.
vi.mock('../../config.js', () => ({
  TEAM_CHATS: { HUB: NaN, SUPPORT: NaN, CHANNEL: NaN },
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

describe('reconcileKnownChats seed filtering', () => {
  /**
   * Ruling 1: TEAM_CHATS.* constants are `parseInt(env.X)` and are `NaN` when the env var is
   * unset. `BigInt(NaN)` throws, so an unset constant must never reach the seed set — it
   * must be filtered out before the BigInt conversion, not merely skipped by getChatMember.
   */
  it('ignores NaN seed chat ids from unset TEAM_CHATS env vars', async () => {
    listActive.mockResolvedValue([]);
    locationFindMany.mockResolvedValue([]);
    const spy = api();

    const result = await reconcileKnownChats(spy);

    expect(result).toEqual({ confirmed: 0, lost: 0, discovered: 0 });
    expect((spy as { getChatMember: ReturnType<typeof vi.fn> }).getChatMember).not.toHaveBeenCalled();
  });
});
