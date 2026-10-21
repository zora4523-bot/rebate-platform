import { expect, it } from 'vitest';
import { createLinkQuoteRunner } from '../../../../apps/api/src/modules/agent/tools/quote/index.ts';
import { ParsingError } from '../../../../apps/api/src/modules/parsing/index.ts';
import { candidate, context, expectSafeView, fixture, productKey, productOf } from './kit.ts';

// Synthetic opaque input, not a claim about any platform's token syntax. Preserve whitespace.
const token = { kind: 'tpwd' as const, raw: '  SYNTHETIC-TOKEN-04f\n合成口令  ', index: 1 };

it('[AC-B3-04f#1][BR-AI-01][BR-AI-04] 口令原样解析一次，再报价、登记并出一张契约卡，不转链', async () => {
  const f = fixture();
  const ctx = context();
  const outcome = await createLinkQuoteRunner(f.deps).run(token, ctx);
  expect(outcome.kind).toBe('ok');
  if (outcome.kind !== 'ok') return;
  expect(f.parseToken).toHaveBeenCalledExactlyOnceWith(token.raw, {
    appId: ctx.appId,
    requestId: ctx.runId,
    purpose: 'online',
    signal: ctx.signal,
  });
  expect(productOf(outcome.cards)).toMatchObject({
    product_key: productKey,
    platform: 'jd',
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
  expect(f.assemble).toHaveBeenCalledExactlyOnceWith(
    {
      scene: 'active_query',
      deferLink: true,
      item: f.current.item,
      ref: f.current.ref,
      entrySource: 'agent',
      stale: false,
    },
    ctx,
  );
  expect(f.quote).toHaveBeenCalledTimes(1);
  expect(f.quote.mock.calls[0]?.[0]).toBe(f.current.item);
  expect(f.commits).toHaveBeenCalledTimes(1);
  expect(f.register).toHaveBeenCalledExactlyOnceWith({
    viewer: ctx,
    item: f.current.item,
    ref: f.current.ref,
    quote: {
      rebateMinFen: 137n,
      rebateMaxFen: 137n,
      estNetPriceFen: 2853n,
      rebateBasis: 'normal',
    },
    entrySource: 'agent',
  });
  expect(f.parseToken.mock.invocationCallOrder[0]).toBeLessThan(
    f.assemble.mock.invocationCallOrder[0]!,
  );
  expect(f.quote.mock.invocationCallOrder[0]).toBeLessThan(f.register.mock.invocationCallOrder[0]!);
  expect(outcome.trace?.link_registrations).toEqual([
    { link_id: 'synthetic-link', product_key: productKey, ok: true },
  ]);
  expectSafeView(outcome.modelView);
  expect(f.parseUrl).not.toHaveBeenCalled();
  expect(f.readProduct).not.toHaveBeenCalled();
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
  expect(f.openLink).not.toHaveBeenCalled();
});

it('[AC-B3-04f#2][BR-AI-04] 价格券与返利使用口令解析的同一快照，不拼接另一轮数据', async () => {
  const f = fixture();
  const parsed = f.current;
  f.parseToken.mockResolvedValue(parsed);
  // Any accidental URL/detail reread would now return a different time and price.
  f.clock.advanceMs(60_000);
  f.setProduct({
    ...parsed,
    item: {
      ...parsed.item,
      price_fen: 5000n,
      coupon_fen: 500n,
      final_price_fen: 4500n,
      quoted_at: '2026-10-15T08:01:00+08:00',
    },
    ref: {
      ...parsed.ref,
      rawFetchedAt: '2026-10-15T08:01:00+08:00',
      receivedAt: f.clock.now().toISOString(),
    },
  });
  f.quote.mockImplementation(async (item) =>
    item === parsed.item
      ? { rebateMinFen: 137n, rebateMaxFen: 137n, estNetPriceFen: 2853n, rebateBasis: 'normal' }
      : { rebateMinFen: 211n, rebateMaxFen: 211n, estNetPriceFen: 4289n, rebateBasis: 'normal' },
  );
  const outcome = await createLinkQuoteRunner(f.deps).run(token, context());
  expect(outcome.kind).toBe('ok');
  expect(productOf(outcome.cards)).toMatchObject({
    price_fen: 3990,
    coupon_fen: 1000,
    final_price_fen: 2990,
    rebate_min_fen: 137,
    rebate_max_fen: 137,
    est_net_price_fen: 2853,
    quoted_at: '2026-10-15T08:00:00+08:00',
    source: 'jd_union',
  });
  expect(f.parseToken).toHaveBeenCalledTimes(1);
  expect(f.assemble.mock.calls[0]?.[0].item).toBe(parsed.item);
  expect(f.assemble.mock.calls[0]?.[0].ref).toBe(parsed.ref);
  expect(f.quote).toHaveBeenCalledTimes(1);
  expect(f.quote.mock.calls[0]?.[0]).toBe(parsed.item);
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(f.register.mock.calls[0]?.[0]).toMatchObject({
    item: parsed.item,
    ref: parsed.ref,
    quote: { rebateMinFen: 137n, rebateMaxFen: 137n, estNetPriceFen: 2853n },
  });
  expect(f.parseUrl).not.toHaveBeenCalled();
  expect(f.readProduct).not.toHaveBeenCalled();
});

// BR-AI-04 required fields, tested at the public catalog boundary before commit.
it.each([
  'price_fen',
  'coupon_fen',
  'final_price_fen',
  'rebate_min_fen',
  'rebate_max_fen',
  'rebate_basis',
  'availability',
  'quoted_at',
  'source',
])('[AC-B3-04f#2][BR-AI-04] 口令商品必需字段 %s 为 null 时 no_card，不登记', async (field) => {
  const f = fixture();
  f.patchCard({ [field]: null });
  const outcome = await createLinkQuoteRunner(f.deps).run(token, context());
  // The call assertions also distinguish this from the old unconditional token no_card.
  expect(f.parseToken).toHaveBeenCalledTimes(1);
  expect(f.assemble).toHaveBeenCalledTimes(1);
  expect(outcome).toEqual({ kind: 'no_card', cards: [] });
  expect(f.commits).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  expect(f.parseUrl).not.toHaveBeenCalled();
  expect(f.readProduct).not.toHaveBeenCalled();
});

it('[AC-B3-04f#2][BR-AI-04] 口令商品券为零合法，不能按缺失处理', async () => {
  const f = fixture();
  f.setProduct({
    ...f.current,
    item: { ...f.current.item, coupon_fen: 0n, final_price_fen: 3990n },
  });
  f.setQuote({
    rebateMinFen: 137n,
    rebateMaxFen: 137n,
    estNetPriceFen: 3853n,
    rebateBasis: 'normal',
  });
  const outcome = await createLinkQuoteRunner(f.deps).run(token, context());
  expect(outcome.kind).toBe('ok');
  expect(productOf(outcome.cards)).toMatchObject({ coupon_fen: 0, final_price_fen: 3990 });
  expect(f.parseToken).toHaveBeenCalledTimes(1);
  expect(f.register).toHaveBeenCalledTimes(1);
});

it.each(['amount_unknown', 'login_required'] as const)(
  '[AC-B3-04f#2][BR-AI-04] 口令卡 %s 允许返利上下限为 null，不补零',
  async (basis) => {
    const f = fixture();
    f.patchCard({
      rebate_basis: basis,
      rebate_min_fen: null,
      rebate_max_fen: null,
      est_net_price_fen: null,
    });
    const outcome = await createLinkQuoteRunner(f.deps).run(token, context());
    expect(outcome.kind).toBe('ok');
    expect(productOf(outcome.cards)).toMatchObject({
      rebate_basis: basis,
      rebate_min_fen: null,
      rebate_max_fen: null,
    });
    expect(f.register).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B3-04f#3][BR-AI-04] 解析后价格不可得，与 URL 一样返回 price_unavailable', async () => {
  const f = fixture();
  f.setProduct({ ...f.current, item: { ...f.current.item, price_status: 'anomaly' } });
  const outcome = await createLinkQuoteRunner(f.deps).run(token, context());
  expect(outcome).toEqual({ kind: 'price_unavailable', cards: [] });
  expect(f.parseToken).toHaveBeenCalledTimes(1);
  expect(f.assemble).toHaveBeenCalledTimes(1);
  expect(f.quote).not.toHaveBeenCalled();
  expect(f.commits).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  expect(f.parseUrl).not.toHaveBeenCalled();
  expect(f.readProduct).not.toHaveBeenCalled();
});

it('[AC-B3-04f#4][BR-AI-04] 没有 tokens 端口时返回 30132，不走其他解析或报价入口', async () => {
  const f = fixture();
  const runner = createLinkQuoteRunner({
    parsing: f.deps.parsing,
    catalog: f.deps.catalog,
    references: f.deps.references,
  });
  expect(await runner.run(token, context())).toEqual({
    kind: 'parse_error',
    error_code: 30132,
    cards: [],
  });
  expect(f.parseToken).not.toHaveBeenCalled();
  expect(f.parseUrl).not.toHaveBeenCalled();
  expect(f.readProduct).not.toHaveBeenCalled();
  expect(f.assemble).not.toHaveBeenCalled();
  expect(f.quote).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
  expect(f.openLink).not.toHaveBeenCalled();
});

it.each([30131, 30132, 30141, 50301] as const)(
  '[AC-B3-04f#5][BR-AI-04] 口令 ParsingError(%s) 保留原码，只失败本次调用',
  async (code) => {
    const f = fixture();
    f.parseToken.mockRejectedValue(new ParsingError(code, `合成失败 ${token.raw}`));
    const outcome = await createLinkQuoteRunner(f.deps).run(token, context());
    expect(outcome).toEqual({ kind: 'parse_error', error_code: code, cards: [] });
    expect(f.parseToken).toHaveBeenCalledTimes(1);
    expect(f.assemble).not.toHaveBeenCalled();
    expect(f.quote).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
    expect(f.parseUrl).not.toHaveBeenCalled();
    expect(f.readProduct).not.toHaveBeenCalled();
    expect(f.convert).not.toHaveBeenCalled();
    expect(f.openLink).not.toHaveBeenCalled();
  },
);

it.each(['Error', 'TimeoutError', 'AbortError'])(
  '[AC-B3-04f#6][BR-AI-04] 非业务异常 %s 原样拒绝，由调用方处理单个失败',
  async (name) => {
    const f = fixture();
    const error = new Error('合成端口异常');
    error.name = name;
    f.parseToken.mockRejectedValue(error);
    await expect(createLinkQuoteRunner(f.deps).run(token, context())).rejects.toBe(error);
    expect(f.parseToken).toHaveBeenCalledTimes(1);
    expect(f.assemble).not.toHaveBeenCalled();
    expect(f.quote).not.toHaveBeenCalled();
    expect(f.commits).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
    expect(f.parseUrl).not.toHaveBeenCalled();
    expect(f.readProduct).not.toHaveBeenCalled();
  },
);

it('[AC-B3-04f#7][BR-AI-04] 解析上下文只包含应用、运行编号、用途和原始 signal', async () => {
  const f = fixture();
  const ctx = context({
    context: { product_key: 'jd:synthetic-untrusted-context' },
    placeholders: { synthetic_placeholder: 'synthetic-private-value' },
  });
  const outcome = await createLinkQuoteRunner(f.deps).run(token, ctx);
  expect(outcome.kind).toBe('ok');
  expect(f.parseToken).toHaveBeenCalledExactlyOnceWith(token.raw, {
    appId: 'synthetic-app',
    requestId: 'synthetic-run',
    purpose: 'online',
    signal: ctx.signal,
  });
  const passed = f.parseToken.mock.calls[0]?.[1];
  expect(passed?.signal).toBe(ctx.signal);
  expect(Object.keys(passed ?? {}).sort()).toEqual(['appId', 'purpose', 'requestId', 'signal']);
  for (const field of [
    'userId',
    'deviceId',
    'phoneBound',
    'placeholders',
    'context',
    'sessionId',
  ]) {
    expect(passed).not.toHaveProperty(field);
  }
});

// Task §9 explicitly asks for raw-token containment; BR-AI-06 is contextual, not an expanded ref.
it.each(['ok', 'parse_error'] as const)(
  '[AC-B3-04f#8][BR-AI-04] 口令原文不进入 %s 的卡片、fallback、modelView 或 trace',
  async (kind) => {
    const f = fixture();
    if (kind === 'parse_error') {
      f.parseToken.mockRejectedValue(new ParsingError(30132, `合成错误包含 ${token.raw}`));
    }
    const outcome = await createLinkQuoteRunner(f.deps).run(token, context());
    expect(outcome.kind).toBe(kind);
    // Trimmed marker catches normalized leaks too; JSON escapes raw's literal newline.
    expect(JSON.stringify(outcome)).not.toContain('SYNTHETIC-TOKEN-04f');
    expect(JSON.stringify(outcome)).not.toContain(JSON.stringify(token.raw).slice(1, -1));
    if (outcome.kind === 'ok') {
      productOf(outcome.cards);
      expectSafeView(outcome.modelView);
      expect(outcome.cards[0]?.fallback_text).toEqual(expect.any(String));
      expect(outcome.trace?.link_registrations).toHaveLength(1);
    }
  },
);

it('[AC-B3-04f#9][BR-AI-01][BR-AI-04] 同一 runner 的 URL→口令失败→URL→口令成功互不污染', async () => {
  const f = fixture();
  const runner = createLinkQuoteRunner(f.deps);
  const ctx = context();
  const firstProduct = f.current;
  f.register
    .mockResolvedValueOnce({ linkId: 'synthetic-link-first' })
    .mockResolvedValueOnce({ linkId: 'synthetic-link-second' })
    .mockResolvedValueOnce({ linkId: 'synthetic-link-third' });
  const first = await runner.run(candidate, ctx);
  expect(first.kind).toBe('ok');
  expect(f.parseToken).not.toHaveBeenCalled();
  expect(f.register).toHaveBeenCalledTimes(1);
  const savedFirst = JSON.stringify(first);
  f.parseToken.mockRejectedValueOnce(new ParsingError(30132, '合成单个失败'));
  const failed = await runner.run(token, ctx);
  expect(failed).toEqual({ kind: 'parse_error', error_code: 30132, cards: [] });
  expect(f.parseUrl).toHaveBeenCalledTimes(1);
  expect(f.register).toHaveBeenCalledTimes(1);

  const secondProduct = {
    ...firstProduct,
    ref: { ...firstProduct.ref, productKey: 'jd:synthetic-second' },
  };
  f.setProduct(secondProduct);
  const secondUrl = { ...candidate, raw: 'https://example.invalid/synthetic-second', index: 2 };
  const second = await runner.run(secondUrl, ctx);
  expect(second.kind).toBe('ok');
  expect(f.parseToken).toHaveBeenCalledTimes(1);
  expect(f.register).toHaveBeenCalledTimes(2);

  const thirdProduct = {
    ...firstProduct,
    ref: { ...firstProduct.ref, productKey: 'jd:synthetic-third' },
  };
  f.setProduct(thirdProduct);
  const thirdToken = { ...token, raw: 'SYNTHETIC-TOKEN-SUCCESS', index: 3 };
  const third = await runner.run(thirdToken, ctx);
  expect(third.kind).toBe('ok');
  expect(f.parseUrl).toHaveBeenCalledTimes(2);
  expect(f.parseUrl.mock.calls.map(([raw]) => raw)).toEqual([candidate.raw, secondUrl.raw]);
  expect(f.parseToken).toHaveBeenCalledTimes(2);
  expect(f.parseToken.mock.calls.map(([raw]) => raw)).toEqual([token.raw, thirdToken.raw]);
  // Four calls contain three successes: two URLs plus one token, each registers once.
  expect(f.register).toHaveBeenCalledTimes(3);
  expect(f.register.mock.calls.map(([input]) => input.ref.productKey)).toEqual([
    productKey,
    'jd:synthetic-second',
    'jd:synthetic-third',
  ]);
  const expected = [
    [first, productKey, 'synthetic-link-first'],
    [second, 'jd:synthetic-second', 'synthetic-link-second'],
    [third, 'jd:synthetic-third', 'synthetic-link-third'],
  ] as const;
  for (const [outcome, key, linkId] of expected) {
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') continue;
    expect(productOf(outcome.cards)).toMatchObject({ product_key: key, link_id: linkId });
    expect(outcome.trace?.link_registrations).toEqual([
      { link_id: linkId, product_key: key, ok: true },
    ]);
  }
  expect(JSON.stringify(first)).toBe(savedFirst);
  expect(failed).toEqual({ kind: 'parse_error', error_code: 30132, cards: [] });
  expect(f.readProduct).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
  expect(f.openLink).not.toHaveBeenCalled();
});

it('[AC-B3-04f#10][BR-AI-01][BR-AI-04] URL 成功与解析失败保持旧口径，口令与其一致', async () => {
  const f = fixture();
  const runner = createLinkQuoteRunner(f.deps);
  const ctx = context();
  const url = await runner.run(candidate, ctx);
  expect(url.kind).toBe('ok');
  expect(productOf(url.cards)).toMatchObject({
    product_key: productKey,
    price_fen: 3990,
    coupon_fen: 1000,
    final_price_fen: 2990,
    rebate_min_fen: 137,
    rebate_max_fen: 137,
    link_id: 'synthetic-link',
  });
  expect(f.parseToken).not.toHaveBeenCalled();
  f.parseUrl.mockRejectedValueOnce(new ParsingError(30141, '合成已下架'));
  const urlError = await runner.run(candidate, ctx);
  expect(urlError).toEqual({ kind: 'parse_error', error_code: 30141, cards: [] });
  expect(f.register).toHaveBeenCalledTimes(1);
  // Pair the URL regression with the new entry: this test must also fail before implementation.
  const tokenOutcome = await runner.run(token, ctx);
  expect(tokenOutcome).toEqual(url);
  f.parseToken.mockRejectedValueOnce(new ParsingError(30141, '合成已下架'));
  expect(await runner.run(token, ctx)).toEqual(urlError);
  expect(f.parseUrl).toHaveBeenCalledTimes(2);
  expect(f.parseToken).toHaveBeenCalledTimes(2);
  expect(f.register).toHaveBeenCalledTimes(2);
  expect(f.readProduct).not.toHaveBeenCalled();
});
