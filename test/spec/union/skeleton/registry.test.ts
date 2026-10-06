import { expect, it } from 'vitest';
import {
  createUnionRegistry,
  type UnionAdapter,
  type UnionIdentity,
} from '../../../../apps/api/src/modules/union/index.ts';
import { online, platforms, window } from './kit.ts';

it('[AC-B1-04b-REGISTRY#1] 仅预登记京东、拼多多、淘宝，明确标记未实现', () => {
  expect(
    [...createUnionRegistry().registrations()].sort((a, b) => a.platform.localeCompare(b.platform)),
  ).toEqual([
    { platform: 'jd', implemented: false },
    { platform: 'pdd', implemented: false },
    { platform: 'taobao', implemented: false },
  ]);
});

const operations: readonly [string, (port: UnionAdapter) => Promise<unknown>][] = [
  ['searchItems', (port) => port.searchItems({ keyword: '测试' }, online)],
  ['getItem', (port) => port.getItem({ platform: port.platform, itemId: 'id' }, online)],
  ['resolveLink', (port) => port.resolveLink('https://example.invalid/item', online)],
  ['listOrders', (port) => port.listOrders(window, {}, { ...online, purpose: 'order_sync' })],
  [
    'convert',
    (port) =>
      port.convert(
        { item: { platform: port.platform }, idempotencyKey: 'key' },
        {} as UnionIdentity,
        online,
      ),
  ],
];

it.each(platforms)(
  '[AC-B1-04b-REGISTRY#2] %s 的必选接口全部明确拒绝，不用假数据冒充实现',
  async (platform) => {
    const port = createUnionRegistry().get(platform);
    expect(port.platform).toBe(platform);
    for (const [operation, call] of operations) {
      await expect(
        Promise.resolve().then(() => call(port)),
        operation,
      ).rejects.toMatchObject({ code: 'adapter_unimplemented', platform });
    }
  },
);

it.each(platforms)('[AC-B1-04b-REGISTRY#3] %s 选配接口若存在也明确拒绝', async (platform) => {
  const port = createUnionRegistry().get(platform);
  const available = [
    port.bindPublisher && (() => port.bindPublisher?.({ authorizationCode: 'synthetic' }, online)),
    port.listRefunds && (() => port.listRefunds?.(window, online)),
    port.listPunishments && (() => port.listPunishments?.(window, online)),
    port.materialFeed && (() => port.materialFeed?.({}, online)),
    port.createTaolijin &&
      (() =>
        port.createTaolijin?.(
          { item: { platform }, amount_fen: 1n, idempotencyKey: 'key' },
          online,
        )),
  ].filter((call) => call !== undefined);
  expect(port.platform).toBe(platform);
  for (const call of available) {
    await expect(Promise.resolve().then<unknown>(() => call())).rejects.toMatchObject({
      code: 'adapter_unimplemented',
      platform,
    });
  }
});
