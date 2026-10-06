import { expect, it } from 'vitest';
import type { SearchProductsQuery } from '../../../../apps/api/src/modules/catalog/search.ts';
import { candidate, claims, fixture, observed } from './kit.ts';

it('[AC-B1-05d#16] 同页同键择券后价最低、返利上限最高、原次序最前，并保留中奖 goods_sign', async () => {
  const f = fixture();
  const variants = [
    candidate('expensive', 2000n, 0n, 'pdd'),
    candidate('low-rebate', 1000n, 0n, 'pdd'),
    candidate('winner', 1000n, 0n, 'pdd'),
    candidate('later-tie', 1000n, 0n, 'pdd'),
  ];
  f.pages.set(1, {
    items: variants.map((value) => ({
      ...value,
      ref: { ...value.ref, productKey: 'pdd:synthetic-shared' },
    })),
    hasMore: false,
  });
  f.quotes.set('synthetic-expensive', { min: 900n, max: 900n });
  f.quotes.set('synthetic-low-rebate', { min: 10n, max: 10n });
  f.quotes.set('synthetic-winner', { min: 20n, max: 20n });
  f.quotes.set('synthetic-later-tie', { min: 20n, max: 20n });
  const result = await f.run({ platform: 'pdd' });
  expect(result.items.map((card) => card.title)).toEqual(['synthetic-winner']);
  const winningLink = f.register.mock.calls.find(
    ([input]) => input.item.title === 'synthetic-winner',
  );
  expect(winningLink?.[0]).toMatchObject({
    item: { goods_sign: 'synthetic-plan-winner' },
    ref: { rawItemId: 'synthetic-plan-winner' },
  });
});

it('[AC-B1-05d#17] 去重比较 resolveProductKey 后的键，不以 raw ID 或标题代替', async () => {
  const f = fixture();
  const old = candidate('old', 2000n);
  const canonical = candidate('new', 1000n);
  const different = candidate('other', 3000n);
  f.aliases.set(old.ref.productKey, canonical.ref.productKey);
  f.pages.set(1, {
    items: [
      old,
      canonical,
      { ...different, item: { ...different.item, title: canonical.item.title } },
    ],
    hasMore: false,
  });
  const result = await f.run();
  expect(result.items.map((card) => card.final_price_fen)).toEqual([1000, 3000]);
  expect(f.resolveProductKey).toHaveBeenCalledWith(old.ref.productKey);
});

it('[AC-B1-05d#18] 已下发商品在后页剔除，包括别名；缓存原页不被去重改写', async () => {
  const f = fixture();
  const a = candidate('a');
  const alias = candidate('alias');
  f.aliases.set(alias.ref.productKey, a.ref.productKey);
  const firstPage = { items: [a, candidate('b')], hasMore: true };
  f.pages.set(1, firstPage);
  f.pages.set(2, { items: [alias, candidate('c')], hasMore: false });
  // Return the same frozen page on both first-page requests: reader must not rewrite it.
  Object.freeze(firstPage.items);
  Object.freeze(firstPage);
  f.search.mockImplementation(async (input) => f.pages.get(input.pageNo)!);
  const first = await f.run({ limit: 2 });
  expect(first.items).toHaveLength(2);
  const second = await f.run({ limit: 2, cursor: first.next_cursor! });
  expect(second.items.map((card) => card.title)).toEqual(['synthetic-c']);
  const fresh = await f.run({ limit: 2 });
  expect(fresh.items.map((card) => card.title)).toEqual(['synthetic-a', 'synthetic-b']);
  expect(firstPage.items).toHaveLength(2);
  expect(claims(f, fresh.next_cursor)?.search_session_id).not.toBe(
    claims(f, first.next_cursor)?.search_session_id,
  );
});

it('[AC-B1-05d#19] 我方游标只含会话 ID 和上游页码，不含商品键、身份、推广位或偏移', async () => {
  const f = fixture();
  f.pages.set(1, { items: [candidate('a')], hasMore: true });
  const first = await f.run({ limit: 1 });
  expect(first.next_cursor).toEqual(expect.any(String));
  expect(f.cursors.encode).toHaveBeenCalledExactlyOnceWith({
    search_session_id: expect.any(String),
    page_no: 2,
  });
  expect(claims(f, first.next_cursor)).toEqual({
    search_session_id: expect.any(String),
    page_no: 2,
  });
  expect(f.sessions.write).toHaveBeenCalledWith(
    'synthetic-app',
    expect.any(String),
    expect.any(Object),
    1800,
  );
});

it.each([
  { q: '另一组合成词' },
  { sort: 'final_price_asc' },
  { sort: 'rebate_desc' },
  { has_coupon: true },
  { price_min_fen: 500 },
  { price_max_fen: 5000 },
  { platform: 'jd' },
] satisfies Partial<SearchProductsQuery>[])(
  '[AC-B1-05d#20] 参数变化 %j 新开会话并从第 1 页查',
  async (change) => {
    const f = fixture();
    f.pages.set(1, { items: [candidate('a', 1000n, 1n)], hasMore: true });
    const first = await f.run({ limit: 1 });
    expect(first.next_cursor).toEqual(expect.any(String));
    if (change.platform)
      f.pages.set(1, { items: [candidate('a', 1000n, 1n, change.platform)], hasMore: true });
    const changed = await f.run({ limit: 1, cursor: first.next_cursor!, ...change });
    expect(changed.items).toHaveLength(1);
    expect(f.search.mock.calls.map(([input]) => input.pageNo)).toEqual([1, 1]);
    expect(claims(f, changed.next_cursor)?.search_session_id).not.toBe(
      claims(f, first.next_cursor)?.search_session_id,
    );
  },
);

it('[AC-B1-05d#21] 同用户换设备仍沿用会话，身份以 ViewerContext 的 user_id 优先', async () => {
  const f = fixture();
  f.pages.set(1, { items: [candidate('a')], hasMore: true });
  f.pages.set(2, { items: [candidate('a'), candidate('b')], hasMore: false });
  const first = await f.run({ limit: 1 });
  expect(first.items).toHaveLength(1);
  f.setViewer({ deviceId: 'synthetic-other-device' });
  const next = await f.run({ limit: 1, cursor: first.next_cursor! });
  expect(next.items.map((card) => card.title)).toEqual(['synthetic-b']);
  expect(f.search.mock.calls.map(([input]) => input.pageNo)).toEqual([1, 2]);
});

it.each([{ userId: 'synthetic-other-user' }, { appId: 'synthetic-other-app' }])(
  '[AC-B1-05d#22] 不同身份 %j 不继承他人已下发集合',
  async (identity) => {
    const f = fixture();
    f.pages.set(1, { items: [candidate('a')], hasMore: true });
    f.pages.set(2, { items: [candidate('a')], hasMore: false });
    const first = await f.run({ limit: 1 });
    expect(first.items).toHaveLength(1);
    f.setViewer(identity);
    if (identity.appId) {
      for (const [pageNo, page] of f.pages)
        f.pages.set(pageNo, {
          ...page,
          items: page.items.map((value) => ({
            ...value,
            ref: { ...value.ref, appId: identity.appId! },
          })),
        });
    }
    const result = await observed(() => f.run({ limit: 1, cursor: first.next_cursor! }));
    // Wire policy may reject a foreign cursor or restart; silently using its seen set is forbidden.
    if (result.kind === 'rejected') expect(result.error).toMatchObject({ code: 20001 });
    else expect(result.value.items.map((card) => card.title)).toEqual(['synthetic-a']);
  },
);

it('[AC-B1-05d#23] 游客按 device_id 隔离，游客也能正常出卡', async () => {
  const f = fixture();
  f.setViewer({ userId: null });
  f.pages.set(1, { items: [candidate('a')], hasMore: true });
  f.pages.set(2, { items: [candidate('a'), candidate('b')], hasMore: false });
  const first = await f.run({ limit: 1 });
  const sameDevice = await f.run({ limit: 1, cursor: first.next_cursor! });
  expect(sameDevice.items.map((card) => card.title)).toEqual(['synthetic-b']);
  expect(f.register.mock.calls.every(([input]) => input.viewer.userId === null)).toBe(true);
  f.setViewer({ deviceId: 'synthetic-other-device' });
  const other = await observed(() => f.run({ limit: 1, cursor: first.next_cursor! }));
  if (other.kind === 'rejected') expect(other.error).toMatchObject({ code: 20001 });
  else expect(other.value.items.map((card) => card.title)).toEqual(['synthetic-a']);
});

it('[AC-B1-05d#24] 会话 30 分钟无请求过期，活跃翻页刷新空闲时间', async () => {
  const f = fixture();
  for (let pageNo = 1; pageNo <= 10; pageNo += 1)
    f.pages.set(pageNo, { items: [candidate('a'), candidate(`page-${pageNo}`)], hasMore: true });
  const first = await f.run({ limit: 2 });
  f.clock.advanceMs(29 * 60 * 1000);
  const second = await f.run({ limit: 2, cursor: first.next_cursor! });
  expect(second.items.map((card) => card.title)).not.toContain('synthetic-a');
  f.clock.advanceMs(29 * 60 * 1000);
  const third = await f.run({ limit: 2, cursor: second.next_cursor! });
  expect(third.items.map((card) => card.title)).not.toContain('synthetic-a');
  expect(f.sessions.write.mock.calls.every(([, , , ttl]) => ttl === 1800)).toBe(true);
  f.clock.advanceMs(30 * 60 * 1000 + 1);
  const expired = await observed(() => f.run({ limit: 2, cursor: third.next_cursor! }));
  if (expired.kind === 'rejected') expect(expired.error).toMatchObject({ code: 20001 });
  else {
    expect(expired.value.items.map((card) => card.title)).toContain('synthetic-a');
    expect(claims(f, expired.value.next_cursor)?.search_session_id).not.toBe(
      claims(f, first.next_cursor)?.search_session_id,
    );
  }
});

it.each([false, true])(
  '[AC-B1-05d#25] 已下发集合最多 500 个，超过后停止会话去重：overflow=%s',
  async (overflow) => {
    const f = fixture();
    const pageCount = overflow ? 11 : 10;
    for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
      f.pages.set(pageNo, {
        items: Array.from({ length: 50 }, (_, index) => candidate(`p${pageNo}-${index}`)),
        hasMore: true,
      });
    }
    f.pages.set(pageCount + 1, { items: [candidate('p1-0')], hasMore: false });
    let cursor: string | undefined;
    for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
      const result = await f.run({ limit: 50, ...(cursor === undefined ? {} : { cursor }) });
      expect(result.items).toHaveLength(50);
      expect(result.next_cursor).toEqual(expect.any(String));
      cursor = result.next_cursor!;
    }
    const repeated = await f.run({ limit: 50, cursor: cursor! });
    expect(repeated.items.map((card) => card.title)).toEqual(overflow ? ['synthetic-p1-0'] : []);
    expect(f.sessions.write.mock.calls.every(([, , session]) => session.seen.length <= 500)).toBe(
      true,
    );
  },
);

it('[AC-B1-05d#26] 已过滤未下发商品不进入 seen，返利恢复后下一页仍可出现', async () => {
  const f = fixture();
  f.pages.set(1, { items: [candidate('zero'), candidate('a')], hasMore: true });
  f.pages.set(2, { items: [candidate('zero')], hasMore: false });
  f.quotes.set('synthetic-zero', { min: 0n, max: 0n });
  const first = await f.run({ limit: 1 });
  expect(first.items.map((card) => card.title)).toEqual(['synthetic-a']);
  f.quotes.set('synthetic-zero', { min: 10n, max: 20n });
  const next = await f.run({ limit: 1, cursor: first.next_cursor! });
  expect(next.items.map((card) => card.title)).toEqual(['synthetic-zero']);
});

it.each([
  null,
  { search_session_id: 'synthetic-session', page_no: 0 },
  { search_session_id: 'synthetic-session', page_no: -1 },
  { search_session_id: 'synthetic-session', page_no: 1.5 },
  { search_session_id: 'synthetic-session', page_no: '2' },
  { page_no: 2 },
  { search_session_id: 'synthetic-session', page_no: 2, offset: 1 },
])('[AC-B1-05d#40] 非法游标载荷 %j 返回参数错误，不能带入联盟请求', async (payload) => {
  const f = fixture();
  f.cursors.payloads.set('synthetic-invalid-cursor', payload);
  await expect(f.run({ cursor: 'synthetic-invalid-cursor' })).rejects.toMatchObject({
    code: 20001,
  });
  expect(f.search).not.toHaveBeenCalled();
});

it('[AC-B1-05d#41] 同查询不同查看者按当前报价过滤，不能复用上一查看者返利', async () => {
  const f = fixture();
  f.pages.set(1, { items: [candidate('a')], hasMore: false });
  const first = await f.run();
  expect(first.items).toHaveLength(1);
  f.setViewer({ userId: 'synthetic-other-user' });
  f.quotes.set('synthetic-a', { min: 0n, max: 0n });
  const other = await f.run();
  expect(other.items).toEqual([]);
  expect(f.quote).toHaveBeenLastCalledWith(
    expect.any(Object),
    expect.objectContaining({ userId: 'synthetic-other-user' }),
    expect.any(Object),
  );
});
