import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pending = vi.fn();
const markProcessed = vi.fn();
const markFailed = vi.fn();
const revokeAccess = vi.fn();
const createInviteLink = vi.fn();
const syncUserAccess = vi.fn();

vi.mock('../aws-business-client.js', () => ({
  awsBusinessClient: {
    pendingAccessRevocations: pending,
    markAccessRevocationProcessed: markProcessed,
    markAccessRevocationFailed: markFailed,
  },
}));
vi.mock('../access-service.js', () => ({
  accessService: { revokeAccess, createInviteLink, syncUserAccess },
}));
vi.mock('../../core/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../core/log-events.js', () => ({
  logBusinessEvent: vi.fn(),
  logSecurityEvent: vi.fn(),
}));

const { runAccessRevocationsForTest } = await import('../access-revocation-dispatcher.js');

const fakeBot = () =>
  ({ api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) } }) as never;

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('access revocation dispatcher', () => {
  it('revokes access for a REVOKE row and acknowledges it', async () => {
    pending.mockResolvedValue({
      items: [
        { publicId: 'req-1', telegramId: '905284110', kind: 'REVOKE', reason: 'Звільнилась' },
      ],
    });
    revokeAccess.mockResolvedValue(undefined);

    await runAccessRevocationsForTest(fakeBot());

    expect(revokeAccess).toHaveBeenCalledWith(905284110n, 'Звільнилась');
    expect(markProcessed).toHaveBeenCalledWith('req-1');
  });

  it('invites the person back for a RESTORE row', async () => {
    pending.mockResolvedValue({
      items: [
        { publicId: 'req-2', telegramId: '905284110', kind: 'RESTORE', reason: 'Повернулась' },
      ],
    });
    createInviteLink.mockResolvedValue('https://t.me/+abc');

    await runAccessRevocationsForTest(fakeBot());

    expect(createInviteLink).toHaveBeenCalledWith(905284110n);
    expect(markProcessed).toHaveBeenCalledWith('req-2');
  });

  /**
   * The commonest failure is the person having blocked the bot — the very case this contour was
   * built for. It must be recorded with its reason, not swallowed.
   */
  it('records a failure with its reason instead of dropping the row', async () => {
    pending.mockResolvedValue({
      items: [
        { publicId: 'req-3', telegramId: '905284110', kind: 'REVOKE', reason: 'Звільнилась' },
      ],
    });
    revokeAccess.mockRejectedValue(new Error('403: bot was blocked by the user'));

    await runAccessRevocationsForTest(fakeBot());

    expect(markFailed).toHaveBeenCalledWith('req-3', expect.stringContaining('blocked'));
    expect(markProcessed).not.toHaveBeenCalled();
  });

  it('keeps going when one row fails', async () => {
    pending.mockResolvedValue({
      items: [
        { publicId: 'a', telegramId: '1', kind: 'REVOKE', reason: 'r' },
        { publicId: 'b', telegramId: '2', kind: 'REVOKE', reason: 'r' },
      ],
    });
    revokeAccess.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);

    await runAccessRevocationsForTest(fakeBot());

    expect(markFailed).toHaveBeenCalledWith('a', expect.any(String));
    expect(markProcessed).toHaveBeenCalledWith('b');
  });

  it('does nothing when the queue is empty', async () => {
    pending.mockResolvedValue({ items: [] });

    await runAccessRevocationsForTest(fakeBot());

    expect(revokeAccess).not.toHaveBeenCalled();
    expect(markProcessed).not.toHaveBeenCalled();
  });
});
