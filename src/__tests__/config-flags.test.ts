import { describe, expect, it } from 'vitest';

describe('canonical replacement flags', () => {
  it('defaults every new canonical flag to false', async () => {
    const config = await import('../config.js');
    expect(config.AWS_REPLACEMENTS_SHADOW_ENABLED).toBe(false);
    expect(config.AWS_REPLACEMENTS_CANONICAL_ENABLED).toBe(false);
    expect(config.AWS_REMINDERS_CANONICAL_READ_ENABLED).toBe(false);
    expect(config.AWS_PREFERENCES_CANONICAL_WRITE_ENABLED).toBe(false);
  });
});
