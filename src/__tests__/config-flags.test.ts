import { describe, expect, it } from 'vitest';

describe('canonical replacement flags', () => {
  it('defaults every new canonical flag to false', async () => {
    const config = await import('../config.js');
    expect(config.AWS_REPLACEMENTS_SHADOW_ENABLED).toBe(false);
    expect(config.AWS_REPLACEMENTS_CANONICAL_ENABLED).toBe(false);
    expect(config.AWS_REMINDERS_CANONICAL_READ_ENABLED).toBe(false);
    expect(config.AWS_PREFERENCES_CANONICAL_WRITE_ENABLED).toBe(false);
    expect(config.AWS_REPLACEMENT_AUTO_CONFIRM_ENABLED).toBe(false);
  });
});

// The rest of the flag chain — start-hook export, and the deploy script's
// default/validate/set_env trio — is asserted by
// `scripts/aws/check-production-deploy-contract.mjs`, which owns the whole
// production deploy contract and now runs in CI. Duplicating it here would
// mean two places to update for one rule.
