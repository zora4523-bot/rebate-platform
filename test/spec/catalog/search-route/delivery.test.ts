import { expect, it } from 'vitest';
import { candidate, fixture, observed } from '../search/kit.ts';

it('[AC-B1-05j#14] 同一游标重试仍返回该页，不能把该页当作历史 seen 清空', async () => {
  const f = fixture();
  f.pages.set(1, { items: [candidate('first')], hasMore: true });
  f.pages.set(2, { items: [candidate('second')], hasMore: true });
  f.pages.set(3, { items: [candidate('third')], hasMore: false });
  const first = await f.run({ limit: 1 });
  expect(first.next_cursor).toEqual(expect.any(String));
  const query = { limit: 1, cursor: first.next_cursor! };
  const second = await f.run(query);
  expect(second.items.map((card) => card.title)).toEqual(['synthetic-second']);
  const repeated = await observed(() => f.run(query));
  expect(repeated).toMatchObject({
    kind: 'returned',
    value: { items: [expect.objectContaining({ title: 'synthetic-second' })], has_more: true },
  });
  if (repeated.kind !== 'returned') return;
  expect(f.cursors.decode(repeated.value.next_cursor!)).toEqual(
    f.cursors.decode(second.next_cursor!),
  );
});

it('[AC-B1-05j#15] 并发同游标不会丢失任一下发键，随后翻页不能重复下发', async () => {
  const f = fixture();
  f.pages.set(1, { items: [candidate('first')], hasMore: true });
  const first = await f.run({ limit: 1 });
  expect(first.next_cursor).toEqual(expect.any(String));
  // Both requests are started before the storage reads resolve. The fixed clock and explicit
  // storage snapshot gate reproduce a stale-reader race without sleeps or network timing.
  // Releasing the gate before awaiting completion also permits implementations that serialize
  // requests at a higher level: they can read the newly committed session on the second read.
  const gate = Promise.withResolvers<void>();
  const read = f.sessions.read.getMockImplementation()!;
  f.sessions.read.mockImplementation(async (appId, id) => {
    const snapshot = await read(appId, id);
    await gate.promise;
    return snapshot;
  });
  let calls = 0;
  f.search.mockImplementation(async (request) => {
    if (request.pageNo === 2) {
      calls += 1;
      return { items: [candidate(calls === 1 ? 'left' : 'right')], hasMore: true };
    }
    return { items: [candidate('left'), candidate('right'), candidate('tail')], hasMore: false };
  });
  const query = { limit: 1, cursor: first.next_cursor! };
  const left = observed(() => f.run(query));
  const right = observed(() => f.run(query));
  gate.resolve();
  const results = await Promise.all([left, right]);
  expect(results.every((result) => result.kind === 'returned')).toBe(true);
  const emitted = new Set<string | null>();
  for (const result of results) {
    if (result.kind !== 'returned') continue;
    expect(result.value.items).toHaveLength(1);
    for (const card of result.value.items) emitted.add(card.title);
  }
  const completed = results[0];
  if (completed?.kind !== 'returned') return;
  const next = await f.run({ limit: 1, cursor: completed.value.next_cursor! });
  expect(next.items.some((card) => emitted.has(card.title))).toBe(false);
});

it('[AC-B1-05j#16] 补拉候选超出 limit 时只为最终下发卡登记 link', async () => {
  const f = fixture();
  f.pages.set(1, { items: [candidate('first')], hasMore: true });
  f.pages.set(2, { items: [candidate('second'), candidate('not-issued')], hasMore: true });
  const result = await observed(() => f.run({ limit: 2 }));
  expect(result).toMatchObject({
    kind: 'returned',
    value: {
      items: [
        expect.objectContaining({ title: 'synthetic-first' }),
        expect.objectContaining({ title: 'synthetic-second' }),
      ],
    },
  });
  expect(f.register.mock.calls.map(([input]) => input.item.title)).toEqual([
    'synthetic-first',
    'synthetic-second',
  ]);
});

it('[AC-B1-05j#17] 同页同键只为胜出候选登记 link，保留最低券后价的原始计划', async () => {
  const f = fixture();
  const expensive = candidate('expensive', 2000n, 0n, 'pdd');
  const cheap = candidate('cheap', 1000n, 0n, 'pdd');
  f.aliases.set(expensive.ref.productKey!, 'pdd:synthetic-canonical');
  f.aliases.set(cheap.ref.productKey!, 'pdd:synthetic-canonical');
  f.pages.set(1, { items: [expensive, cheap], hasMore: false });
  const result = await observed(() => f.run({ platform: 'pdd' }));
  expect(result).toMatchObject({
    kind: 'returned',
    value: { items: [expect.objectContaining({ title: 'synthetic-cheap' })] },
  });
  expect(f.register).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      item: expect.objectContaining({ goods_sign: 'synthetic-plan-cheap' }),
      ref: expect.objectContaining({ rawItemId: 'synthetic-plan-cheap' }),
    }),
  );
});
