import { expect, it } from 'vitest';
import type { ItemRef, TimeWindow } from '../../../../apps/api/src/modules/union/domain/types.ts';
import type { TaobaoUnionAdapter } from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import { ctx, setup, TestIdentity, unionFailure } from './kit.ts';

// The request base only: every UnionAdapter port is a placeholder until the field mappings of the
// next segment (② 段) land under their own rule tests.
//
// test-change 2026-10-31 (union-lane): getItem in AC-B1-04j#30 was the request base's temporary
// placeholder; B1-04l implements it (taobao.tbk.item.info.upgrade.get) under its own rule tests in
// test/spec/union/taobao-goods/**. The remaining ports stay asserted adapter_unimplemented.
type PortCall = [string, (adapter: TaobaoUnionAdapter) => Promise<unknown>];

const item: ItemRef = { platform: 'taobao', itemId: 'synthetic-item' };
const window: TimeWindow = { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' };

const ports: PortCall[] = [
  ['searchItems', (adapter) => adapter.searchItems({ keyword: 'synthetic keyword' }, ctx)],
  ['resolveLink', (adapter) => adapter.resolveLink('https://example.invalid/synthetic', ctx)],
  [
    'convert',
    (adapter) =>
      adapter.convert({ item, idempotencyKey: 'synthetic-key' }, new TestIdentity(), ctx),
  ],
  ['listOrders', (adapter) => adapter.listOrders(window, {}, ctx)],
];

it.each(ports)(
  '[AC-B1-04j#30] %s is adapter_unimplemented without credentials or transport',
  async (_name, call) => {
    const { adapter, credentials, transport, warn } = setup();
    await unionFailure(() => call(adapter), 'adapter_unimplemented');
    expect(credentials).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04j#31] identifies taobao and does not advertise Pinduoduo-only ports', () => {
  const { adapter } = setup();
  expect(adapter.platform).toBe('taobao');
  for (const name of ['getPddOrderDetail', 'queryPddAuthority', 'pddAuthorityUrl']) {
    expect(Reflect.get(adapter, name)).toBeUndefined();
  }
});
