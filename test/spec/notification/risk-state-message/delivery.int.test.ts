import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createRiskStateMessageHandler } from '../../../../apps/api/src/modules/notification/application/risk-state-message.ts';
import { needsTaobaoReauth } from '../../../../apps/api/src/modules/linking/index.ts';
import { failInsert, fixture, openSuite, type Suite } from './db-kit.ts';
import { NOW, variants } from './fixtures.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

it.each(variants)(
  '[AC-B1-12g#8] $variant 从事件快照写一条信与成功日志，无模板仍可发',
  async (row) => {
    const f = await fixture(suite);
    const received = f.event({
      from: row.from,
      to: row.to,
      frozen_until: row.frozen_until,
      reason_category: row.to === 'normal' ? null : 'abnormal_trade',
    });
    const start = suite.queries.length;
    await f.deliver(received);
    expect(suite.queries.slice(start).some((query) => query.includes('user_risk_state'))).toBe(
      false,
    );
    const { inbox, logs } = await f.rows();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      app_id: f.appId,
      user_id: f.userId,
      code: 'RISK_STATE_CHANGED',
      title: '账户通知',
      body: row.body,
      route: null,
      read_at: null,
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      app_id: f.appId,
      user_id: f.userId,
      code: 'RISK_STATE_CHANGED',
      channel: 'inbox',
      status: 'success',
      dedupe_key: `risk.state_changed:${received.eventId}`,
      planned_at: new Date(NOW),
      sent_at: new Date(NOW),
    });
  },
);

it('[AC-B1-12g#9] 同事件顺序重复投递不加信、不改原文案与时间，事务可提交', async () => {
  const f = await fixture(suite);
  const received = f.event();
  await f.deliver(received);
  const before = await f.rows();
  f.clock.advanceMs(90_000);
  await f.template('frozen', { title_override: '更新后的标题', body_override: '更新后的正文' });
  await f.deliver({ ...received, attempt: 2 });
  expect(await f.rows()).toEqual(before);
  expect(before.inbox).toHaveLength(1);
  expect(before.logs).toHaveLength(1);
});

it('[AC-B1-12g#10] 并发事务投递同事件，PG 唯一约束最终只留一信一日志，所有投递成功', async () => {
  const f = await fixture(suite);
  const received = f.event();
  const handler = createRiskStateMessageHandler({
    clock: f.clock,
    taobaoReauthReader: needsTaobaoReauth,
  });
  // Bypass processed_events on purpose: notify_logs must be a second, independent boundary.
  const outcomes = await Promise.allSettled(
    Array.from({ length: 6 }, () => f.db.transaction().execute((trx) => handler(received, trx))),
  );
  expect(outcomes.map((result) => result.status)).toEqual(
    Array.from({ length: 6 }, () => 'fulfilled'),
  );
  const rows = await f.rows();
  expect(rows.inbox).toHaveLength(1);
  expect(rows.logs).toHaveLength(1);
});

it('[AC-B1-12g#11] 已存在 notify_logs 去重键时不新增站内信，不依赖 processed_events', async () => {
  const f = await fixture(suite);
  const received = f.event();
  await f.log(received);
  const before = await f.rows();
  const handler = createRiskStateMessageHandler({
    clock: f.clock,
    taobaoReauthReader: needsTaobaoReauth,
  });
  await f.db.transaction().execute(async (trx) => {
    await handler(received, trx);
    // A swallowed 23505 must not leave an aborted transaction that silently rolls back.
    expect((await sql<{ n: number }>`select 1 as n`.execute(trx)).rows).toEqual([{ n: 1 }]);
  });
  expect(await f.rows()).toEqual(before);
  expect(before.inbox).toEqual([]);
});

it('[AC-B1-12g#12] 同用户相同内容的不同事件分别发信，不能按用户或文案去重', async () => {
  const f = await fixture(suite);
  const first = f.event();
  const second = { ...first, eventId: randomUUID() };
  await f.deliver(first);
  await f.deliver(second);
  const rows = await f.rows();
  expect(rows.inbox).toHaveLength(2);
  expect(rows.logs.map((row) => row.dedupe_key).sort()).toEqual(
    [`risk.state_changed:${first.eventId}`, `risk.state_changed:${second.eventId}`].sort(),
  );
});

it('[AC-B1-12g#13] 相同事件编号在不同 app_id 各自去重与投递', async () => {
  const a = await fixture(suite);
  const b = await fixture(suite);
  const first = a.event();
  await a.deliver(first);
  await b.deliver({ ...b.event(), eventId: first.eventId });
  expect((await a.rows()).inbox).toMatchObject([{ app_id: a.appId, user_id: a.userId }]);
  expect((await b.rows()).inbox).toMatchObject([{ app_id: b.appId, user_id: b.userId }]);
  expect((await b.rows()).logs).toMatchObject([
    { dedupe_key: `risk.state_changed:${first.eventId}` },
  ]);
});

it('[AC-B1-12g#14] 两表使用调用方事务：提交前对外不可见，外层失败后两表皆空，可重投', async () => {
  const f = await fixture(suite);
  const received = f.event();
  const handler = createRiskStateMessageHandler({
    clock: f.clock,
    taobaoReauthReader: needsTaobaoReauth,
  });
  const abort = new Error('fixture-rollback');
  await expect(
    f.db.transaction().execute(async (trx) => {
      await handler(received, trx);
      const inside = await f.rows(trx);
      expect(inside.inbox).toHaveLength(1);
      expect(inside.logs).toHaveLength(1);
      expect(await f.rows()).toEqual({ inbox: [], logs: [] });
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await f.rows()).toEqual({ inbox: [], logs: [] });
  await f.deliver(received);
  const committed = await f.rows();
  expect(committed.inbox).toHaveLength(1);
  expect(committed.logs).toHaveLength(1);
});

it.each(['inbox_messages', 'notify_logs'] as const)(
  '[AC-B1-12g#15] %s 写入失败不吞错，两表回滚，重投成功',
  async (table) => {
    const f = await fixture(suite);
    const received = f.event();
    const handler = createRiskStateMessageHandler({
      clock: f.clock,
      taobaoReauthReader: needsTaobaoReauth,
    });
    const fault = failInsert(table);
    await expect(
      f.db.transaction().execute((trx) => handler(received, trx.withPlugin(fault.plugin))),
    ).rejects.toMatchObject({ code: '22012' });
    expect(fault.fired()).toBe(true);
    expect(await f.rows()).toEqual({ inbox: [], logs: [] });
    await f.deliver(received);
    const rows = await f.rows();
    expect(rows.inbox).toHaveLength(1);
    expect(rows.logs).toHaveLength(1);
  },
);

it.each([
  ['frozen', 'appealing'],
  ['banned', 'appealing'],
  ['appealing', 'normal'],
  ['appealing', 'frozen'],
  ['appealing', 'banned'],
] as const)('[AC-B1-12g#16] %s → %s 不落信、不写通知日志', async (from, to) => {
  const f = await fixture(suite);
  await f.deliver(f.event({ from, to }));
  expect(await f.rows()).toEqual({ inbox: [], logs: [] });
});

it('[AC-B1-12g#17] 不按当前时间丢弃迟到冻结事件，冻结与解除事件各用自身载荷', async () => {
  const f = await fixture(suite);
  f.clock.set('2026-11-30T04:05:06.789Z');
  const freeze = f.event({ frozen_until: '2026-11-29T16:00:00.000Z' });
  const restore = f.event({ from: 'frozen', to: 'normal', reason_category: null });
  await f.deliver(restore);
  await f.deliver(freeze);
  const rows = await f.rows();
  expect(rows.inbox.map((row) => row.body).sort()).toEqual(
    [
      '你的账户提现已恢复。',
      '你的账户提现已暂停至 11-30 00:00，原因：异常交易。如有疑问，可在帮助中心提交申诉。',
    ].sort(),
  );
  expect(rows.logs).toHaveLength(2);
});

it('[AC-B1-12g#28] normal → normal 没有对应变体，消费成功且不落信、不写通知日志', async () => {
  const f = await fixture(suite);
  await f.deliver(f.event({ from: 'normal', to: 'normal', reason_category: null }));
  expect(await f.rows()).toEqual({ inbox: [], logs: [] });
});

it.each([
  [
    '2026-12-31T15:59:00.000Z',
    '你的账户提现已暂停至 2027-01-01 00:07，原因：异常交易。如有疑问，可在帮助中心提交申诉。',
  ],
  [
    '2026-12-31T16:00:00.000Z',
    '你的账户提现已暂停至 01-01 00:07，原因：异常交易。如有疑问，可在帮助中心提交申诉。',
  ],
] as const)('[AC-B1-12g#29] 写入正文以注入时钟 %s 的上海年份判断跨年', async (now, body) => {
  const f = await fixture(suite);
  f.clock.set(now);
  await f.deliver(f.event({ frozen_until: '2026-12-31T16:07:00.000Z' }));
  const rows = await f.rows();
  expect(rows.inbox).toMatchObject([{ body }]);
  expect(rows.logs).toMatchObject([{ planned_at: new Date(now), sent_at: new Date(now) }]);
});
