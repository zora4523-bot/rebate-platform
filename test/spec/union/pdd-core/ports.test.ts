import { expect, it } from 'vitest';
import { setup } from './kit.ts';

// test-change 2026-10-15 (pdd-lane): AC-B1-04g-PORT#1 (searchItems / getItem / resolveLink / convert /
// listOrders stay adapter_unimplemented) and the queryPddAuthority / materialFeed absence were the
// request base's temporary placeholders; B1-04i (listOrders), B1-04u (search / detail / resolve /
// materialFeed) and B1-04h (convert / queryPddAuthority) implement them under their own rule tests.
// Ports no pdd task plans to provide stay asserted absent.
it('[AC-B1-04g-PORT#2] identifies pdd and does not advertise optional ports no pdd task provides', () => {
  const { adapter } = setup();
  expect(adapter.platform).toBe('pdd');
  for (const name of ['bindPublisher', 'listRefunds', 'listPunishments', 'createTaolijin']) {
    expect(Reflect.get(adapter, name)).toBeUndefined();
  }
});
