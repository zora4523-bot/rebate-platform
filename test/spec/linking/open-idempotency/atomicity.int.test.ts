// Scope: B1-06m's explicit transaction/attempt excerpt, BR-PRICE-12 and BR-PRICE-20.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  added,
  capture,
  databaseFixture,
  deferred,
  fixture,
  reprice,
  service,
  snapshot,
  source,
  success,
  USER_A,
  USER_B,
  type Snapshot,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each([
  { ac: 1, label: '本人链接涨价', owner: USER_A, price: 3190n, newLinks: 1 },
  { ac: 2, label: '他人链接归属与涨价', owner: USER_B, price: 3190n, newLinks: 2 },
  { ac: 3, label: '他人链接只改归属', owner: USER_B, price: 2990n, newLinks: 1 },
  { ac: 4, label: '游客认领与涨价', owner: null, price: 3190n, newLinks: 1 },
  { ac: 5, label: '游客认领且价格不变', owner: null, price: 2990n, newLinks: 0 },
])(
  '[AC-B1-06m#$ac] $label：故障全回滚，同键重试只一套，跨实例重放仍返回原编号',
  async ({ owner, price, newLinks }) => {
    const db = database();
    const f = fixture(db);
    const original = await source(f, owner);
    reprice(f, price);
    const s = service(f);
    const request = f.request(original.link_id);
    const before = await snapshot(db);
    const fault = new Error('synthetic-before-idempotency-completion');
    const observed: { outside: Snapshot; inside: Snapshot; code: number }[] = [];
    f.hooks.after = async (_request, trx, result) => {
      observed.push({
        outside: await snapshot(db),
        inside: await snapshot(trx),
        code: result.envelope.code,
      });
      throw fault;
    };

    // The existing execute path bypasses the injection and resolves: assertion-red, not a crash.
    const failed = await capture(s.open(request));
    expect(failed.kind).toBe('rejected');
    expect(failed).toEqual({ kind: 'rejected', error: fault });
    if (failed.kind === 'rejected') expect(failed.error).toBe(fault);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.code).toBe(0);
    expect(observed[0]!.outside).toEqual(before);
    const staged = added(before, observed[0]!.inside);
    expect(staged.links).toHaveLength(newLinks);
    expect(staged.logs.filter((row) => row.event === 'open')).toHaveLength(1);
    expect(staged.attempts).toHaveLength(1);
    expect(staged.keys).toEqual([expect.objectContaining({ status: 'processing' })]);
    // Includes original quote/identity/row_version and every register/open log, not just counts.
    expect(await snapshot(db)).toEqual(before);

    delete f.hooks.after;
    // Keep the service and clock: a cached single-flight card from the rolled-back open must
    // not make this immediate retry return a link that was never persisted.
    const result = success(await capture(s.open(request)));
    const committed = await snapshot(db);
    const rows = added(before, committed);
    const effective = result.new_link_id ?? original.link_id;
    expect(result).toMatchObject({
      old_final_price_fen: '2990',
      new_final_price_fen: price.toString(),
    });
    expect(rows.links).toHaveLength(newLinks);
    expect(rows.attempts).toEqual([
      expect.objectContaining({
        attempt_id: result.attempt_id,
        app_id: original.app_id,
        link_id: effective,
        user_id: USER_A,
        opened_at: f.clock.now(),
      }),
    ]);
    const openLogs = rows.logs.filter((row) => row.event === 'open');
    expect(openLogs).toEqual([
      expect.objectContaining({
        app_id: original.app_id,
        link_id: effective,
        result_code: 0,
        opener_user_id: USER_A,
      }),
    ]);
    expect(rows.keys).toEqual([
      expect.objectContaining({
        app_id: original.app_id,
        subject: `u:${USER_A}`,
        status: 'completed',
        key: request.idempotencyKey,
        path: `/v1/links/${original.link_id}/open`,
      }),
    ]);
    const target = committed.links.find((row) => row.link_id === effective);
    expect(target).toMatchObject({
      user_id: USER_A,
      quoted_final_price_fen: price,
      identity_snapshot: expect.objectContaining({ user_id: USER_A }),
    });
    const sourceAfter = committed.links.find((row) => row.link_id === original.link_id)!;
    if (owner === null) {
      expect(sourceAfter).toMatchObject({
        user_id: USER_A,
        identity_snapshot: expect.objectContaining({ user_id: USER_A }),
        quoted_final_price_fen: 2990n,
        quoted_at: original.quoted_at,
        row_version: original.row_version + 1,
      });
    } else {
      expect(sourceAfter).toEqual(before.links.find((row) => row.link_id === original.link_id));
    }
    if (owner === USER_B && price !== 2990n) {
      expect(rows.links.map((row) => row.quoted_final_price_fen).sort()).toEqual([2990n, price]);
      expect(rows.links.every((row) => row.user_id === USER_A)).toBe(true);
    }
    const writeRows = [
      ...rows.links,
      ...rows.logs,
      ...rows.attempts,
      ...rows.keys,
      ...(owner === null ? [sourceAfter] : []),
    ];
    expect(new Set(writeRows.map((row) => row.write_xid)).size).toBe(1);

    const calls = { fetch: f.fetch.mock.calls.length, convert: f.convert.mock.calls.length };
    f.clock.advanceMs(8001);
    reprice(f, 3990n);
    const replay = success(
      await capture(service(f).open({ ...request, traceId: 'synthetic-replay-trace' })),
    );
    expect(replay).toEqual(result);
    expect(await snapshot(db)).toEqual(committed);
    expect(f.fetch).toHaveBeenCalledTimes(calls.fetch);
    expect(f.convert).toHaveBeenCalledTimes(calls.convert);
  },
);

it('[AC-B1-06m#6] 单飞跨不同键：A 已写业务但提交前回滚，B 成功的响应与 attempt 必须引用已提交的新 link', async () => {
  const db = database();
  const f = fixture(db);
  const original = await source(f);
  reprice(f, 3190n);
  const s = service(f);
  const firstRequest = f.request(original.link_id);
  const secondRequest = f.request(original.link_id);
  const before = await snapshot(db);
  const firstReady = deferred<void>();
  const releaseFirst = deferred<void>();
  const secondEntered = deferred<void>();
  const fault = new Error('synthetic-first-open-rollback');
  f.hooks.before = async (request) => {
    if (request.key === secondRequest.idempotencyKey) secondEntered.resolve();
  };
  f.hooks.after = async (request) => {
    if (request.key === firstRequest.idempotencyKey) {
      firstReady.resolve();
      await releaseFirst.promise;
      throw fault;
    }
  };
  const first = capture(s.open(firstRequest));
  let second: typeof first | undefined;
  try {
    // A legacy implementation finishes instead of reaching the gate. Race against its result
    // so the expected red is an assertion, never a hung barrier or a timeout.
    const reached = await Promise.race([
      firstReady.promise.then(() => 'business-written'),
      first.then(() => 'finished-early'),
    ]);
    expect(reached).toBe('business-written');
    expect(await snapshot(db)).toEqual(before);
    f.clock.advanceMs(1000);
    const pendingSecond = capture(s.open(secondRequest));
    second = pendingSecond;
    const entered = await Promise.race([
      secondEntered.promise.then(() => 'entered'),
      pendingSecond.then(() => 'finished-early'),
    ]);
    expect(entered).toBe('entered');
    releaseFirst.resolve();
    expect(await first).toEqual({ kind: 'rejected', error: fault });
    const result = success(await pendingSecond);
    expect(result).toMatchObject({ new_final_price_fen: '3190', old_final_price_fen: '2990' });
    expect(result.new_link_id).toEqual(expect.any(String));
    const committed = await snapshot(db);
    const rows = added(before, committed);
    expect(rows.links).toEqual([
      expect.objectContaining({
        link_id: result.new_link_id,
        quoted_final_price_fen: 3190n,
        user_id: USER_A,
      }),
    ]);
    expect(rows.logs.filter((row) => row.event === 'open')).toEqual([
      expect.objectContaining({ link_id: result.new_link_id, result_code: 0 }),
    ]);
    expect(rows.attempts).toEqual([
      expect.objectContaining({
        attempt_id: result.attempt_id,
        link_id: result.new_link_id,
        user_id: USER_A,
      }),
    ]);
    expect(rows.keys).toEqual([
      expect.objectContaining({
        key: secondRequest.idempotencyKey,
        status: 'completed',
      }),
    ]);
    expect(
      new Set(
        [...rows.links, ...rows.logs, ...rows.attempts, ...rows.keys].map((row) => row.write_xid),
      ).size,
    ).toBe(1);
    // Both requests arrived in one frozen window; the failed commit must not force B to
    // accept an unpersisted card or perform another price check/conversion.
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.convert).toHaveBeenCalledTimes(1);
    expect(success(await capture(service(f).open(secondRequest)))).toEqual(result);
    expect(await snapshot(db)).toEqual(committed);
  } finally {
    releaseFirst.resolve();
    await first;
    await second;
  }
});
