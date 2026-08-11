import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * A flag reaches the running bot only if it is declared in all four places:
 * the deploy workflow input, the release.env writer, the start hook's export
 * list, and the deploy script's own default/validate/set_env trio. Miss one
 * and the deploy still succeeds, the summary still prints `true`, and the bot
 * silently starts with the flag off — which is exactly what happened to
 * AWS_REPLACEMENT_AUTO_CONFIRM_ENABLED on its first production deploy.
 */
describe('flag plumbing', () => {
  const root = join(__dirname, '../..');
  const read = (path: string) => readFileSync(join(root, path), 'utf8');

  const workflow = read('.github/workflows/deploy-aws-production.yml');
  const startHook = read('deploy/aws/hooks/start.sh');
  const deployScript = read('scripts/aws/deploy-production-bot.sh');

  // Every boolean AWS_*_ENABLED flag the workflow writes into release.env must
  // survive the whole chain. Derived from the workflow rather than hardcoded,
  // so a flag added there is automatically covered here. Non-boolean values
  // like AWS_REGION travel a different path and are deliberately excluded.
  const flags = [...workflow.matchAll(/printf '(AWS_[A-Z0-9_]+_ENABLED)=%q\\n'/gu)].map(
    (m) => m[1],
  );

  it('writes at least the canonical flags into release.env', () => {
    expect(flags).toContain('AWS_REPLACEMENT_AUTO_CONFIRM_ENABLED');
    expect(flags.length).toBeGreaterThanOrEqual(8);
  });

  it.each(flags)('%s is exported by the start hook', (flag) => {
    expect(startHook).toContain(flag);
  });

  it.each(flags)('%s is defaulted, validated and set by the deploy script', (flag) => {
    expect(deployScript).toContain(`${flag}="\${${flag}:-false}"`);
    expect(deployScript).toContain(`echo "${flag} must be true or false."`);
    expect(deployScript).toContain(`set_env ${flag} "$${flag}"`);
  });
});
