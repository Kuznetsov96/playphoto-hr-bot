import { describe, expect, it, vi } from 'vitest';

describe('canonical replacement flags', () => {
  it('defaults every new canonical flag to false', async () => {
    const config = await import('../config.js');
    expect(config.AWS_REPLACEMENTS_SHADOW_ENABLED).toBe(false);
    expect(config.AWS_REPLACEMENTS_CANONICAL_ENABLED).toBe(false);
    expect(config.AWS_REMINDERS_CANONICAL_READ_ENABLED).toBe(false);
    expect(config.AWS_PREFERENCES_CANONICAL_WRITE_ENABLED).toBe(false);
    expect(config.AWS_REPLACEMENT_AUTO_CONFIRM_ENABLED).toBe(false);
  });

  it('defaults the recruiting mirror push flag to false', async () => {
    const config = await import('../config.js');
    expect(config.AWS_RECRUITING_MIRROR_ENABLED).toBe(false);
  });

  it('defaults the canonical interview slots flag to false', async () => {
    const config = await import('../config.js');
    expect(config.AWS_RECRUITING_SLOTS_ENABLED).toBe(false);
  });

  it('defaults the recruiter commands flag to false', async () => {
    const config = await import('../config.js');
    expect(config.AWS_RECRUITING_COMMANDS_ENABLED).toBe(false);
  });
});

describe('FINANCE_DDS_TARGET derived from the deploy flag', () => {
  // The deploy form can only carry booleans, so production sets
  // AWS_DDS_API_WRITE_ENABLED and the string target is derived here. A fresh
  // module registry per case: config parses process.env once at import.
  const loadTarget = async (env: Record<string, string | undefined>) => {
    const previous = { ...process.env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
    try {
      const config = await import('../config.js');
      return config.FINANCE_DDS_TARGET;
    } finally {
      process.env = previous;
      vi.resetModules();
    }
  };

  it('writes only to the sheet when the flag is unset', async () => {
    await expect(
      loadTarget({ AWS_DDS_API_WRITE_ENABLED: undefined, FINANCE_DDS_TARGET: undefined })
    ).resolves.toBe('sheets');
  });

  it('writes only to the sheet when the flag is off', async () => {
    await expect(
      loadTarget({ AWS_DDS_API_WRITE_ENABLED: 'false', FINANCE_DDS_TARGET: undefined })
    ).resolves.toBe('sheets');
  });

  // `both`, not `api`: the sheet stays live so the two paths can be compared on
  // real data during the parallel week.
  it('writes to both the sheet and the webapp when the flag is on', async () => {
    await expect(
      loadTarget({ AWS_DDS_API_WRITE_ENABLED: 'true', FINANCE_DDS_TARGET: undefined })
    ).resolves.toBe('both');
  });

  it('lets an explicit target win, for local runs and tests', async () => {
    await expect(
      loadTarget({ AWS_DDS_API_WRITE_ENABLED: 'false', FINANCE_DDS_TARGET: 'api' })
    ).resolves.toBe('api');
  });
});

// The rest of the flag chain — start-hook export, and the deploy script's
// default/validate/set_env trio — is asserted by
// `scripts/aws/check-production-deploy-contract.mjs`, which owns the whole
// production deploy contract and now runs in CI. Duplicating it here would
// mean two places to update for one rule.
