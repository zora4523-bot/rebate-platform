import { expect, it } from 'vitest';
import type * as LevelApi from '../../../../apps/api/src/modules/identity/application/identity-level.ts';

// Explicit oracle from B1-02za §9.3 / BR-ID-01, not derived from production logic.
const cases = [
  ['phone', false, 'none', 10005],
  ['phone', false, 'verified', 10005],
  ['phone', true, 'none', null],
  ['phone', true, 'failed', null],
  ['phone', true, 'verified', null],
  ['realname', false, 'none', 10005],
  ['realname', false, 'failed', 10005],
  ['realname', false, 'verified', 10005],
  ['realname', true, 'none', 30304],
  ['realname', true, 'failed', 30304],
  ['realname', true, 'verified', null],
  ['none', false, 'none', null],
  ['optional', false, 'failed', null],
  ['login', false, 'none', null],
  [undefined, false, 'none', null],
] as const;

for (const [required, phoneBound, realnameStatus, expected] of cases) {
  it(`[AC-B1-02za#1] ${required} phone=${phoneBound} realname=${realnameStatus} → ${expected}`, async () => {
    const identity = (await import(
      new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
    )) as typeof LevelApi;
    expect(identity.identityLevelRefusal({ required, phoneBound, realnameStatus })).toBe(expected);
  });
}
