import { expect, it } from 'vitest';
import {
  UnionIdentity,
  type CallCtx,
  type UnionAdapter,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import { setup, unionFailure } from './kit.ts';

const ctx: CallCtx = { appId: 'example-app', requestId: 'example-request', purpose: 'online' };
const item = { platform: 'pdd', goods_sign: 'example-goods-sign' } as const;

class TestIdentity extends UnionIdentity {
  constructor() {
    super({
      appId: ctx.appId,
      userId: 'example-user',
      platform: 'pdd',
      promotionSlot: 'example-slot',
      relationId: null,
    });
  }
}

const calls: readonly (readonly [string, (adapter: UnionAdapter) => Promise<unknown>])[] = [
  ['searchItems', (adapter) => adapter.searchItems({ keyword: '例子' }, ctx)],
  ['getItem', (adapter) => adapter.getItem(item, ctx)],
  ['resolveLink', (adapter) => adapter.resolveLink('https://example.invalid/link', ctx)],
  [
    'convert',
    (adapter) => adapter.convert({ item, idempotencyKey: 'example-key' }, new TestIdentity(), ctx),
  ],
  [
    'listOrders',
    (adapter) =>
      adapter.listOrders({ from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' }, {}, ctx),
  ],
];

it.each(calls)(
  '[AC-B1-04g-PORT#1] %s remains adapter_unimplemented and never contacts the gateway',
  async (_name, call) => {
    const { adapter, credentials, transport, warn } = setup();
    await unionFailure(() => call(adapter), 'adapter_unimplemented');
    expect(credentials).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04g-PORT#2] identifies pdd and does not advertise any optional port capability', () => {
  const { adapter } = setup();
  expect(adapter.platform).toBe('pdd');
  for (const name of [
    'queryPddAuthority',
    'materialFeed',
    'bindPublisher',
    'listRefunds',
    'listPunishments',
    'createTaolijin',
  ]) {
    expect(Reflect.get(adapter, name)).toBeUndefined();
  }
});
