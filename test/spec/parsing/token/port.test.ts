import { expect, it } from 'vitest';
import { parseToken, parseUrl } from '../../../../apps/api/src/modules/parsing/index.ts';
import { item, URL_A } from '../core/kit.ts';
import { contextFor, CTX, fixture, NOW, QUOTED_AT, TOKEN } from './kit.ts';

it('[AC-B3-04h-PORT#1] 官方口令只走淘宝识别再取详情，保留同一次取数且不建卡或转链', async () => {
  const f = fixture();
  const ctx = contextFor('synthetic-app-b');
  // Token parsing must not depend on URL host classification.
  const result = await parseToken(
    { ...f.options, linkPatterns: { version: 'synthetic-empty', rules: [] } },
    TOKEN,
    ctx,
  );
  expect(result).toEqual({
    item: f.detail,
    ref: {
      appId: ctx.appId,
      platform: 'taobao',
      productKey: 'tb:001',
      rawItemId: 'synthetic-prefix-001',
      rawFetchedAt: QUOTED_AT,
      receivedAt: NOW,
      canonicalUrl: null,
      title: f.detail.title,
      shopId: null,
      shopType: null,
      source: 'parse',
    },
  });
  expect(f.configValue).toHaveBeenCalledWith(ctx.appId, 'parse.tpwd.enabled');
  expect(f.getGovernedAdapter.mock.calls).toEqual([['taobao']]);
  expect(f.resolveLink.mock.calls).toEqual([[TOKEN, ctx]]);
  expect(f.getItem.mock.calls).toEqual([[f.resolvedRef, ctx]]);
  expect(f.configValue.mock.invocationCallOrder[0]).toBeLessThan(
    f.getGovernedAdapter.mock.invocationCallOrder[0]!,
  );
  expect(f.resolveLink.mock.invocationCallOrder[0]).toBeLessThan(
    f.getItem.mock.invocationCallOrder[0]!,
  );
  expect(f.assemble).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  expect(f.quote).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
  expect(f.searchItems).not.toHaveBeenCalled();
  expect(
    JSON.stringify(result, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  ).not.toContain(TOKEN);
});

it.each([
  ['synthetic-prefix-0007', 'tb:0007'],
  ['0007', 'tb:0007'],
  ['synthetic-prefix-AbC_07', 'tb:AbC_07'],
] as const)('[AC-B3-04h-KEY#1] 淘宝原串%s按统一规则派生，不改写末段', async (itemId, key) => {
  const f = fixture();
  const ref = { platform: 'taobao' as const, item_id: itemId };
  f.resolveLink.mockResolvedValue({ item: ref });
  f.getItem.mockResolvedValue(item(ref));
  const result = await parseToken(f.options, TOKEN, CTX);
  expect(result.ref.productKey).toBe(key);
  expect(result.ref.rawItemId).toBe(itemId);
  expect(f.getItem).toHaveBeenCalledWith(ref, CTX);
});

it('[AC-B3-04h-PORT#2] 相同联盟商品与URL入口返回一致，使用详情原串和原始取数时间', async () => {
  const f = fixture();
  f.getItem.mockResolvedValue(
    item(
      { platform: 'taobao', item_id: 'synthetic-detail-001' },
      {
        price_fen: 10001n,
        coupon_fen: 1n,
        final_price_fen: 10000n,
        quoted_at: '2026-10-06T09:00:30+08:00',
      },
    ),
  );
  const url = await parseUrl(f.options, URL_A, CTX);
  const token = await parseToken(f.options, TOKEN, CTX);
  expect(token).toEqual(url);
  expect(token.ref).toMatchObject({
    rawItemId: 'synthetic-detail-001',
    rawFetchedAt: '2026-10-06T09:00:30+08:00',
    canonicalUrl: null,
    source: 'parse',
  });
  expect(f.assemble).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
});

it('[AC-B3-04h-PORT#3] 同一口令每次重新取详情，不去重或复用上次报价', async () => {
  const f = fixture();
  const first = await parseToken(f.options, TOKEN, CTX);
  const updated = item(f.resolvedRef, {
    price_fen: 15000n,
    final_price_fen: 13000n,
    quoted_at: '2026-10-06T09:02:00+08:00',
  });
  f.getItem.mockResolvedValue(updated);
  const second = await parseToken(f.options, TOKEN, CTX);
  expect(first.item).toEqual(f.detail);
  expect(second.item).toEqual(updated);
  expect(second.ref.rawFetchedAt).toBe(updated.quoted_at);
  expect(f.resolveLink).toHaveBeenCalledTimes(2);
  expect(f.getItem).toHaveBeenCalledTimes(2);
  expect(f.assemble).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
});
