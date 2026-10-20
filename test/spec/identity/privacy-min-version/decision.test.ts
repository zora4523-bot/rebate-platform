import { beforeAll, expect, it } from 'vitest';
import type * as Privacy from '../../../../apps/api/src/modules/identity/application/privacy-consent.ts';

let api: typeof Privacy;
beforeAll(async () => {
  api = (await import(
    new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
  )) as typeof Privacy;
});

for (const [label, minVersion, current, expected] of [
  ['缺配置不判', undefined, { accepted: false, version: 1 }, null],
  ['无用户记录', 3, null, null],
  ['恰好最低版', 3, { accepted: true, version: 3 }, null],
  ['高于最低版', 3, { accepted: true, version: 4 }, null],
  ['比最低版少一', 3, { accepted: true, version: 2 }, 10004],
  ['撤回即使版本高', 3, { accepted: false, version: 9 }, 10004],
  ['最小合法版本', 1, { accepted: true, version: 1 }, null],
  ['int32 上界合法', 2147483647, { accepted: true, version: 2147483647 }, null],
] as const) {
  it(`[AC-B1-02zh#1] ${label}`, () => {
    expect(api.privacyConsentRefusal({ minVersion, current })).toBe(expected);
  });
}

for (const minVersion of [0, -1, 1.5, '3', null, true, {}, 2147483648, NaN, Infinity]) {
  it(`[AC-B1-02zh#2] 非法最低版 ${String(minVersion)} → 50001`, () => {
    expect(() =>
      api.privacyConsentRefusal({ minVersion, current: { accepted: true, version: 9 } }),
    ).toThrow(expect.objectContaining({ code: 50001, statusCode: 500 }));
  });
}
