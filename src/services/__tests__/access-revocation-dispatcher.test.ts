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
    revokeAccess.mockResolvedValue({ attemptedChats: 3, failures: [] });

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

  /**
   * `revokeAccess` never throws for a chat that refuses to remove the
   * user — it logs the failure, writes its own security audit with
   * `result: "failed"`, and resolves normally. Left unchecked, that turns a
   * genuine security failure (the person is still in every protected chat)
   * into a row the dispatcher marks PROCESSED. The failure list on the
   * resolved value is the only signal that survives, so the dispatcher must
   * read it and fail the row itself.
   */
  it('fails the row when every attempted chat refuses removal', async () => {
    pending.mockResolvedValue({
      items: [
        { publicId: 'req-6', telegramId: '905284110', kind: 'REVOKE', reason: 'Звільнилась' },
      ],
    });
    revokeAccess.mockResolvedValue({
      attemptedChats: 3,
      failures: [
        { chatId: -100, error: 'CHAT_ADMIN_REQUIRED' },
        { chatId: -200, error: 'CHAT_ADMIN_REQUIRED' },
        { chatId: -300, error: 'CHAT_ADMIN_REQUIRED' },
      ],
    });

    await runAccessRevocationsForTest(fakeBot());

    expect(markFailed).toHaveBeenCalledWith('req-6', expect.stringContaining('3 of 3'));
    expect(markProcessed).not.toHaveBeenCalled();
  });

  /**
   * A partial removal is not a removal: the person still has access to
   * whichever chat refused. Marking the row processed would tell the owner
   * revocation succeeded when it did not.
   */
  it('fails the row when only some attempted chats refuse removal', async () => {
    pending.mockResolvedValue({
      items: [
        { publicId: 'req-7', telegramId: '905284110', kind: 'REVOKE', reason: 'Звільнилась' },
      ],
    });
    revokeAccess.mockResolvedValue({
      attemptedChats: 3,
      failures: [{ chatId: -200, error: 'CHAT_ADMIN_REQUIRED' }],
    });

    await runAccessRevocationsForTest(fakeBot());

    expect(markFailed).toHaveBeenCalledWith('req-7', expect.stringContaining('1 of 3'));
    expect(markProcessed).not.toHaveBeenCalled();
  });

  it('marks the row processed when every attempted chat succeeds', async () => {
    pending.mockResolvedValue({
      items: [
        { publicId: 'req-8', telegramId: '905284110', kind: 'REVOKE', reason: 'Звільнилась' },
      ],
    });
    revokeAccess.mockResolvedValue({ attemptedChats: 3, failures: [] });

    await runAccessRevocationsForTest(fakeBot());

    expect(markProcessed).toHaveBeenCalledWith('req-8');
    expect(markFailed).not.toHaveBeenCalled();
  });

  /**
   * `revokeAccess` treats "user not found" / "participant_id_invalid" as
   * already-removed, not as a failure — those chats are simply skipped and
   * never added to `failures`. A person who was never in a chat is
   * correctly considered removed from it, so this must still resolve as a
   * processed row, not a failed one.
   */
  it('marks the row processed when a chat is skipped because the user was never a member', async () => {
    pending.mockResolvedValue({
      items: [
        { publicId: 'req-9', telegramId: '905284110', kind: 'REVOKE', reason: 'Звільнилась' },
      ],
    });
    // Two of three chats banned successfully; the third never had the user as a
    // member, so `revokeAccess` skips it internally and it never reaches `failures`.
    revokeAccess.mockResolvedValue({ attemptedChats: 3, failures: [] });

    await runAccessRevocationsForTest(fakeBot());

    expect(markProcessed).toHaveBeenCalledWith('req-9');
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('keeps going when one row fails', async () => {
    pending.mockResolvedValue({
      items: [
        { publicId: 'a', telegramId: '1', kind: 'REVOKE', reason: 'r' },
        { publicId: 'b', telegramId: '2', kind: 'REVOKE', reason: 'r' },
      ],
    });
    revokeAccess
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ attemptedChats: 3, failures: [] });

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

  /**
   * `createInviteLink` has no dedup of its own (unlike `revokeAccess`, which
   * keys concurrent calls off `revokeInFlight`): every call mints a fresh
   * single-use invite. If a slow pass were still in flight when the next
   * poll fired, the same still-pending RESTORE row would be processed twice,
   * handing out two live, untracked invites to the protected channel for one
   * row. The local `iterationInProgress` guard exists to make that
   * impossible within one process.
   */
  it('does not let a second pass overlap a slow first pass', async () => {
    pending.mockResolvedValue({
      items: [
        { publicId: 'req-4', telegramId: '905284110', kind: 'RESTORE', reason: 'Повернулась' },
      ],
    });

    let resolveInviteLink: (link: string) => void;
    createInviteLink.mockReturnValue(
      new Promise<string>(resolve => {
        resolveInviteLink = resolve;
      }),
    );

    const firstPass = runAccessRevocationsForTest(fakeBot());
    // Let the first pass reach and start awaiting `createInviteLink` before
    // the second pass is started.
    await Promise.resolve();
    await Promise.resolve();

    const secondPass = runAccessRevocationsForTest(fakeBot());
    await secondPass;

    expect(pending).toHaveBeenCalledTimes(1);
    expect(createInviteLink).toHaveBeenCalledTimes(1);

    resolveInviteLink!('https://t.me/+abc');
    await firstPass;

    expect(pending).toHaveBeenCalledTimes(1);
    expect(createInviteLink).toHaveBeenCalledTimes(1);
  });

  /**
   * Pins the RESTORE-not-authorised decision: `createInviteLink` returning
   * `null` means the bot's own authorisation check disagrees with the row
   * ever having been queued, and retrying will not change that outcome.
   * The row is still marked processed rather than failed — a `failed` row
   * would make the API re-offer it forever against someone it is never
   * going to succeed for. The reason lives in the security audit
   * (`logSecurityEvent`), not in a call to `markAccessRevocationFailed`.
   */
  it('marks a RESTORE row processed, not failed, when createInviteLink returns null', async () => {
    pending.mockResolvedValue({
      items: [
        { publicId: 'req-5', telegramId: '905284110', kind: 'RESTORE', reason: 'Повернулась' },
      ],
    });
    createInviteLink.mockResolvedValue(null);

    await runAccessRevocationsForTest(fakeBot());

    expect(markProcessed).toHaveBeenCalledWith('req-5');
    expect(markFailed).not.toHaveBeenCalled();
  });
});
