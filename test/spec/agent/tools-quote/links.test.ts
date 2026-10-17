import { expect, it } from 'vitest';
import {
  createLinkQuoteRunner,
  createRebateQuoteHandler,
} from '../../../../apps/api/src/modules/agent/tools/quote/index.ts';
import { createToolRegistry } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import { ParsingError } from '../../../../apps/api/src/modules/parsing/index.ts';
import { candidate, context, expectSafeView, fixture, productKey, productOf } from './kit.ts';

it('[AC-B3-04c#1][BR-AI-01][BR-AI-04] 识别出的链接只解析一次，登记一次报价快照，不转链', async () => {
  const f = fixture();
  const runner = createLinkQuoteRunner(f.deps);
  const ctx = context();
  const outcome = await runner.run(candidate, ctx);
  expect(outcome.kind).toBe('ok');
  if (outcome.kind !== 'ok') return;
  expect(productOf(outcome.cards)).toMatchObject({
    product_key: productKey,
    link_id: 'synthetic-link',
    price_fen: 3990,
    coupon_fen: 1000,
    final_price_fen: 2990,
    rebate_min_fen: 137,
    rebate_max_fen: 137,
    est_net_price_fen: 2853,
    quoted_at: '2026-10-15T08:00:00+08:00',
    source: 'jd_union',
  });
  expect(f.parseUrl).toHaveBeenCalledTimes(1);
  expect(f.parseUrl).toHaveBeenCalledWith(
    candidate.raw,
    expect.objectContaining({
      appId: ctx.appId,
      signal: ctx.signal,
    }),
  );
  expect(f.readProduct).not.toHaveBeenCalled();
  expect(f.assemble).toHaveBeenCalledTimes(1);
  expect(f.assemble).toHaveBeenCalledWith(
    expect.objectContaining({
      scene: 'active_query',
      deferLink: true,
      stale: false,
      item: f.current.item,
      ref: f.current.ref,
    }),
    ctx,
  );
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(f.register).toHaveBeenCalledWith(
    expect.objectContaining({
      item: f.current.item,
      ref: f.current.ref,
      quote: {
        rebateMinFen: 137n,
        rebateMaxFen: 137n,
        estNetPriceFen: 2853n,
        rebateBasis: 'normal',
      },
    }),
  );
  expect(f.convert).not.toHaveBeenCalled();
  expect(f.openLink).not.toHaveBeenCalled();
  expect(outcome.trace?.link_registrations).toEqual([
    { link_id: 'synthetic-link', product_key: productKey, ok: true },
  ]);
  expectSafeView(outcome.modelView);
});

it.each([
  [30132, '无法识别'],
  [30131, '不支持平台'],
  [30141, '下架'],
  [50301, '依赖不可用'],
] as const)(
  '[AC-B3-04c#2][BR-AI-01][BR-AI-04] 解析错误 %s（%s）保持分类且不出卡',
  async (code, label) => {
    const f = fixture();
    const runner = createLinkQuoteRunner(f.deps);
    f.parseUrl.mockRejectedValue(new ParsingError(code, `合成解析失败：${label}`));
    expect(await runner.run(candidate, context())).toEqual({
      kind: 'parse_error',
      error_code: code,
      cards: [],
    });
    expect(f.assemble).not.toHaveBeenCalled();
    expect(f.readProduct).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
    expect(f.convert).not.toHaveBeenCalled();
  },
);

it('[AC-B3-04c#3][BR-AI-04] active_query 价格不可得，不登记也不出金额卡', async () => {
  const f = fixture();
  const runner = createLinkQuoteRunner(f.deps);
  f.setProduct({ ...f.current, item: { ...f.current.item, price_status: 'anomaly' } });
  expect(await runner.run(candidate, context())).toEqual({ kind: 'price_unavailable', cards: [] });
  expect(f.assemble).toHaveBeenCalledWith(
    expect.objectContaining({ scene: 'active_query' }),
    expect.anything(),
  );
  expect(f.register).not.toHaveBeenCalled();
  expect(f.quote).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
});

it('[AC-B3-04c#4][BR-AI-01] 模型只获得 get_rebate_quote，不能直接 resolve_link 或 register_links', async () => {
  const f = fixture();
  const handler = createRebateQuoteHandler(f.deps);
  const registry = createToolRegistry({ handlers: [handler], switches: { get: async () => true } });
  const ctx = context();
  const subject = {
    appId: ctx.appId,
    userId: ctx.userId,
    deviceId: ctx.deviceId,
    phoneBound: true,
    traceId: 'synthetic-trace',
    deviceHash: 'synthetic-device-hash',
    ipKey: 'synthetic-ip-key',
  };
  const definitions = await registry.definitions(ctx.appId, subject);
  expect(definitions.map((definition) => definition.name)).toEqual(['get_rebate_quote']);
  for (const name of ['resolve_link', 'register_links']) {
    const outcome = await registry.execute(
      { id: 'synthetic-call', name, args: {} },
      { ...ctx, subject },
    );
    expect(outcome).toEqual({ kind: 'rejected', modelView: { error: 'invalid_args' } });
  }
  expect(f.parseUrl).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});
