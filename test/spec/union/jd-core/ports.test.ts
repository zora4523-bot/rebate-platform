import { expect, it } from 'vitest';
import { setup } from './kit.ts';

// AC-B1-04za#52 placeholders removed (cf. pdd-core); B1-04zb, zc, zd rule tests own the five ports.
it('[AC-B1-04za#53] identifies jd and does not advertise ports of other platforms', () => {
  const { adapter } = setup();
  expect(adapter.platform).toBe('jd');
  for (const name of [
    'getPddOrderDetail',
    'queryPddAuthority',
    'pddAuthorityUrl',
    'taobaoShareCode',
    'shortenTaobaoUrl',
  ]) {
    expect(Reflect.get(adapter, name)).toBeUndefined();
  }
});
