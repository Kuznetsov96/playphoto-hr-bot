import { beforeEach, describe, expect, it, vi } from 'vitest';

const upsert = vi.fn();
const update = vi.fn();
const findMany = vi.fn();

vi.mock('../../db/core.js', () => ({
  default: { knownChat: { upsert, update, findMany } },
}));

const { knownChatRepository } = await import('../known-chat-repository.js');

beforeEach(() => vi.clearAllMocks());

describe('knownChatRepository.recordPresent', () => {
  /**
   * The bot can be re-added to a chat it already knows. Keyed on the Telegram chat id,
   * so that must update the row rather than fail on a duplicate.
   */
  it('upserts on the telegram chat id', async () => {
    await knownChatRepository.recordPresent({
      id: -100n,
      title: 'Fantasy Town',
      type: 'supergroup',
    });

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { id: -100n } }));
  });

  /** Re-adding a chat the bot had lost must bring it back into the sweep. */
  it('clears lostAt when the bot is present again', async () => {
    await knownChatRepository.recordPresent({
      id: -100n,
      title: 'Fantasy Town',
      type: 'supergroup',
    });

    const call = upsert.mock.calls[0]?.[0];
    expect(call.update).toMatchObject({ lostAt: null });
  });

  it('keeps the title for a readable audit trail', async () => {
    await knownChatRepository.recordPresent({
      id: -100n,
      title: 'Fantasy Town',
      type: 'supergroup',
    });

    const call = upsert.mock.calls[0]?.[0];
    expect(call.create).toMatchObject({ title: 'Fantasy Town' });
  });
});

describe('knownChatRepository.recordLost', () => {
  it('stamps lostAt instead of deleting the row', async () => {
    await knownChatRepository.recordLost(-100n);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: -100n },
        data: expect.objectContaining({ lostAt: expect.any(Date) }),
      }),
    );
  });
});

describe('knownChatRepository.listActive', () => {
  it('returns only chats the bot can still use', async () => {
    findMany.mockResolvedValue([]);

    await knownChatRepository.listActive();

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { lostAt: null } }));
  });
});
