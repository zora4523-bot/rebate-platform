import { expect, it } from 'vitest';
import { parseUrl } from '../../../../apps/api/src/modules/parsing/index.ts';
import { UnionError, type ItemRef } from '../../../../apps/api/src/modules/union/index.ts';
import { CTX, fixture, observed, URL_A, URL_B, URL_C } from './kit.ts';

it.each([
  ['item', 'jd:i_b'],
  ['sku', 'jd:sku-b'],
] as const)('[AC-B1-07a-URL-JD-MODE] URL入口也使用全局京东%s模式', async (mode, key) => {
  const f = fixture();
  f.config.set('product_key.jd.mode', mode);
  const result = await observed(() => parseUrl(f.options, URL_B, CTX));
  expect(result).toMatchObject({
    outcome: 'returned',
    value: { ref: { appId: CTX.appId, platform: 'jd', productKey: key } },
  });
  expect(f.getGovernedAdapter).toHaveBeenCalledWith('jd');
  expect(f.configValue).toHaveBeenCalledWith(CTX.appId, 'product_key.jd.mode');
  expect(f.assemble).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
});

it('[AC-B1-07a-URL-PROMO] URL入口通过联盟解析推广形态，不把短链原文作为商品地址', async () => {
  const f = fixture();
  const url = 'https://promo.example.test/s/synthetic?other_pid=synthetic-promoter';
  f.refs.set(url, { platform: 'taobao', item_id: 'synthetic-prefix-a' });
  const result = await observed(() => parseUrl(f.options, url, CTX));
  expect(result).toMatchObject({
    outcome: 'returned',
    value: { ref: { productKey: 'tb:a', rawItemId: 'synthetic-prefix-a' } },
  });
  expect(f.resolveLink).toHaveBeenCalledWith(url, expect.objectContaining(CTX));
  if (result.outcome === 'returned') {
    expect(result.value.ref.canonicalUrl ?? '').not.toContain('synthetic-promoter');
    expect(result.value.ref.canonicalUrl).not.toBe(url);
  }
  expect(f.assemble).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
});

it('[AC-B1-07a-URL-TABLE] URL入口同样以注入的形态表为准，空表返回30131', async () => {
  const f = fixture();
  const result = await observed(() =>
    parseUrl({ ...f.options, linkPatterns: { version: 'synthetic-empty', rules: [] } }, URL_A, CTX),
  );
  expect(result).toMatchObject({ outcome: 'rejected', error: { code: 30131 } });
  expect(f.getGovernedAdapter).not.toHaveBeenCalled();
  expect(f.resolveLink).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});

it.each(['link_unrecognized', 'adapter_unimplemented'] as const)(
  '[AC-B1-07a-URL-PROMO-UNRESOLVED] 推广链接解析级%s时URL入口返回30132',
  async (code) => {
    const f = fixture();
    f.resolveLink.mockRejectedValue(new UnionError(code, 'synthetic unavailable stage', 'taobao'));
    const result = await observed(() =>
      parseUrl(f.options, 'https://promo.example.test/s/synthetic', CTX),
    );
    expect(result).toMatchObject({ outcome: 'rejected', error: { code: 30132 } });
    expect(f.getItem).not.toHaveBeenCalled();
    expect(f.assemble).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
  },
);

it.each([
  [URL_A, { platform: 'taobao', item_id: 'synthetic- a' }],
  [URL_A, { platform: 'taobao', item_id: 'synthetic-a/b' }],
  [URL_A, { platform: 'taobao', item_id: 'a'.repeat(125) }],
  [URL_B, { platform: 'jd', skuId: 'synthetic-sku' }],
  [URL_C, { platform: 'pdd', goods_sign: 'synthetic-plan' }],
] satisfies readonly [string, ItemRef][])(
  '[AC-B1-07a-URL-UNDERIVABLE] URL入口已识别但不能派生%s，返回30131且不登记',
  async (url, ref) => {
    const f = fixture();
    f.refs.set(url, ref);
    const result = await observed(() => parseUrl(f.options, url, CTX));
    expect(result).toMatchObject({ outcome: 'rejected', error: { code: 30131 } });
    expect(f.assemble).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
    expect(f.convert).not.toHaveBeenCalled();
  },
);
