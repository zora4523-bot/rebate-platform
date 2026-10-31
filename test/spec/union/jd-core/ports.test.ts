import { expect, it } from 'vitest';
import type { ItemRef, TimeWindow } from '../../../../apps/api/src/modules/union/domain/types.ts';
import type { JdUnionAdapter } from '../../../../apps/api/src/modules/union/infra/jd/jd-adapter.ts';
import { ctx, setup, TestIdentity, unionFailure } from './kit.ts';

// The request base only: every UnionAdapter port is a placeholder until the goods, link and order
// tasks land under their own rule tests.
type PortCall = [string, (adapter: JdUnionAdapter) => Promise<unknown>];

const item: ItemRef = { platform: 'jd', itemId: 'synthetic-item' };
const window: TimeWindow = { from: '2026-10-01T00:00:00Z', to: '2026-10-01T01:00:00Z' };

const ports: PortCall[] = [
  ['searchItems', (adapter) => adapter.searchItems({ keyword: 'synthetic keyword' }, ctx)],
  ['getItem', (adapter) => adapter.getItem(item, ctx)],
  ['resolveLink', (adapter) => adapter.resolveLink('https://example.invalid/synthetic', ctx)],
  [
    'convert',
    (adapter) =>
      adapter.convert({ item, idempotencyKey: 'synthetic-key' }, new TestIdentity(), ctx),
  ],
  ['listOrders', (adapter) => adapter.listOrders(window, {}, ctx)],
];

it.each(ports)(
  '[AC-B1-04za#52] %s is adapter_unimplemented without credentials or transport',
  async (_name, call) => {
    const { adapter, credentials, transport, warn } = setup();
    await unionFailure(() => call(adapter), 'adapter_unimplemented');
    expect(credentials).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  },
);

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
