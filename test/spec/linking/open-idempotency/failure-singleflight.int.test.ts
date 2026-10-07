// 50303 single-flight stability is explicitly in B1-06m (task excerpt of BR-PRICE-13).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  added,
  cacheKey,
  capture,
  databaseFixture,
  fixture,
  jump,
  service,
  snapshot,
  source,
  success,
  type Snapshot,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each([0, 3001])(
  '[AC-B1-06m#7] 50303 不存幂等结果：%ims 后同键重发仍执行，每次只留一条事务外日志、不写 attempt',
  async (elapsed) => {
    const db = database();
    const f = fixture(db);
    const original = await source(f);
    const s = service(f);
    const request = f.request(original.link_id);
    const before = await snapshot(db);
    const observed: { outside: Snapshot; transactionId: string | undefined; code: number }[] = [];
    f.hooks.after = async (_request, trx, result) => {
      const inside = await snapshot(trx);
      observed.push({
        outside: await snapshot(db),
        transactionId: inside.keys.find(
          (row) =>
            row.key === request.idempotencyKey && row.path === `/v1/links/${original.link_id}/open`,
        )?.write_xid,
        code: result.envelope.code,
      });
    };
    f.fetch.mockRejectedValue(new Error('synthetic-price-unavailable'));
    const first = await capture(s.open(request));
    expect(first).toEqual({ kind: 'returned', returned: { code: 50303, data: null } });
    // Legacy execute bypasses this observation; it is assertion-red even though its failure
    // log alone looks right. We also check actual transaction IDs, not just spy call counts.
    expect(observed).toHaveLength(1);
    expect(observed[0]!.outside).toEqual(before);
    expect(observed[0]!.code).toBe(50303);
    expect(observed[0]!.transactionId).toEqual(expect.any(String));
    const firstState = await snapshot(db);
    const firstRows = added(before, firstState);
    expect(firstRows.links).toEqual([]);
    expect(firstRows.attempts).toEqual([]);
    expect(firstRows.keys).toEqual([]);
    expect(firstRows.logs).toEqual([
      expect.objectContaining({
        event: 'open',
        link_id: original.link_id,
        result_code: 50303,
      }),
    ]);
    expect(firstRows.logs[0]!.write_xid).not.toBe(observed[0]!.transactionId);

    f.clock.advanceMs(elapsed);
    expect(await capture(s.open(request))).toEqual(first);
    expect(observed).toHaveLength(2);
    expect(observed[1]!.outside).toEqual(firstState);
    expect(f.fetch).toHaveBeenCalledTimes(elapsed === 0 ? 1 : 2);
    const secondRows = added(firstState, await snapshot(db));
    expect(secondRows).toMatchObject({ links: [], attempts: [], keys: [] });
    expect(secondRows.logs).toEqual([
      expect.objectContaining({
        event: 'open',
        link_id: original.link_id,
        result_code: 50303,
      }),
    ]);
    expect(secondRows.logs[0]!.write_xid).not.toBe(observed[1]!.transactionId);
    expect(f.convert).not.toHaveBeenCalled();

    // A non-stored failure must not poison the key: later recovery stores a single success,
    // then replays that attempt without a fourth open log or another external call.
    f.clock.advanceMs(3001);
    f.fetch.mockImplementation(async () => f.state.price);
    const recovered = success(await capture(s.open(request)));
    const finalState = await snapshot(db);
    const finalRows = added(before, finalState);
    expect(
      finalRows.logs.filter((row) => row.event === 'open').map((row) => row.result_code),
    ).toEqual([50303, 50303, 0]);
    expect(finalRows.attempts).toEqual([
      expect.objectContaining({
        attempt_id: recovered.attempt_id,
        link_id: original.link_id,
      }),
    ]);
    expect(finalRows.keys).toEqual([expect.objectContaining({ status: 'completed' })]);
    expect(finalRows.links).toEqual([]);
    expect(success(await capture(service(f).open(request)))).toEqual(recovered);
    expect(await snapshot(db)).toEqual(finalState);
    expect(f.fetch).toHaveBeenCalledTimes(elapsed === 0 ? 2 : 3);
    expect(f.convert).toHaveBeenCalledTimes(1);
    expect(observed).toHaveLength(3);
  },
);

it.each([
  { ac: 8, code: 30141, kind: 'off_shelf' as const },
  { ac: 9, code: 30602, kind: 'tlj_empty' as const },
])(
  '[AC-B1-06m#$ac] 可存储业务失败 $code：日志与幂等同回滚，同键重试后重放不再写',
  async ({ code, kind }) => {
    const db = database();
    const f = fixture(db);
    const original = await source(f);
    f.state.price = { kind };
    const s = service(f);
    const request = f.request(original.link_id);
    const before = await snapshot(db);
    const fault = new Error('synthetic-business-failure-before-completion');
    f.hooks.after = async () => {
      throw fault;
    };
    const failed = await capture(s.open(request));
    expect(failed).toEqual({ kind: 'rejected', error: fault });
    expect(await snapshot(db)).toEqual(before);
    delete f.hooks.after;
    const result = await capture(s.open(request));
    expect(result).toEqual({ kind: 'returned', returned: { code, data: null } });
    const committed = await snapshot(db);
    const rows = added(before, committed);
    expect(rows).toMatchObject({ links: [], attempts: [] });
    expect(rows.logs).toEqual([
      expect.objectContaining({ event: 'open', result_code: code, link_id: original.link_id }),
    ]);
    expect(rows.keys).toEqual([
      expect.objectContaining({ status: 'completed', key: request.idempotencyKey }),
    ]);
    expect(rows.logs[0]!.write_xid).toBe(rows.keys[0]!.write_xid);
    const fetches = f.fetch.mock.calls.length;
    f.clock.advanceMs(8001);
    expect(await capture(service(f).open(request))).toEqual(result);
    expect(await snapshot(db)).toEqual(committed);
    expect(f.fetch).toHaveBeenCalledTimes(fetches);
    expect(f.convert).not.toHaveBeenCalled();
  },
);

it.each([
  { ac: 10, stage: 'price', elapsed: 0 },
  { ac: 11, stage: 'price', elapsed: 3000 },
  { ac: 12, stage: 'catalog', elapsed: 0 },
  { ac: 13, stage: 'catalog', elapsed: 3000 },
])(
  '[AC-B1-06m#$ac] $stage 首次50303后缓存变为可用，窗口内 $elapsed ms 新键仍50303，3001ms重新判定',
  async ({ stage, elapsed }) => {
    const db = database();
    const f = fixture(db);
    const original = await source(f);
    const s = service(f);
    const before = await snapshot(db);
    if (stage === 'price') f.fetch.mockRejectedValue(new Error('synthetic-price-failure'));
    else f.assemble.mockRejectedValue(new Error('synthetic-catalog-failure'));
    const firstRequest = f.request(original.link_id);
    const first = await capture(s.open(firstRequest));
    expect(first).toEqual({ kind: 'returned', returned: { code: 50303, data: null } });
    // Model another open refreshing this same identity's conversion cache. It changes only
    // cache availability, not the failed price conclusion or any database evidence.
    await f.cache.put(cacheKey(original), { jump: jump(), fetchedAt: f.clock.now().toISOString() });
    f.clock.advanceMs(elapsed);
    const secondRequest = f.request(original.link_id);
    expect(secondRequest.idempotencyKey).not.toBe(firstRequest.idempotencyKey);
    expect(await capture(s.open(secondRequest))).toEqual(first);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.assemble).toHaveBeenCalledTimes(stage === 'price' ? 0 : 1);
    expect(f.convert).not.toHaveBeenCalled();
    const inWindow = added(before, await snapshot(db));
    expect(inWindow).toMatchObject({ links: [], attempts: [], keys: [] });
    expect(inWindow.logs).toEqual([
      expect.objectContaining({ event: 'open', result_code: 50303, link_id: original.link_id }),
      expect.objectContaining({ event: 'open', result_code: 50303, link_id: original.link_id }),
    ]);

    // A service that pins 50303 forever is wrong too. Outside the inclusive 3000ms window,
    // a fresh failed re-check may now use the valid conversion cache and create an attempt.
    f.clock.advanceMs(3001 - elapsed);
    const after = success(await capture(s.open(f.request(original.link_id))));
    expect(after).toMatchObject({ jump: jump(), requote_failed: true, new_link_id: null });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.assemble).toHaveBeenCalledTimes(stage === 'price' ? 0 : 2);
    expect(f.convert).not.toHaveBeenCalled();
    const finalRows = added(before, await snapshot(db));
    expect(finalRows.logs.map((row) => row.result_code)).toEqual([50303, 50303, 0]);
    expect(finalRows.attempts).toEqual([
      expect.objectContaining({
        attempt_id: after.attempt_id,
        link_id: original.link_id,
      }),
    ]);
    expect(finalRows.keys).toHaveLength(1);
    expect(finalRows.links).toEqual([]);
  },
);
