import { sql, type Transaction, type ValueNode } from 'kysely';
import type { DB } from '@couli/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  DAY,
  PRIVATE_CONTENT,
  PRIVATE_REASON,
  createScan,
  fixture,
  job,
  warnings,
  type Fixture,
} from './kit.ts';

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
}, 180_000);
afterEach(async () => {
  await f?.close();
});

it('[AC-B1-03j#1][AC-S1-60 ③] 到期前一毫秒不解冻，等于到期时跨 app 恢复 normal，经唯一写者留痕并发事件', async () => {
  const service = await f.service();
  const first = await f.user();
  const second = await f.user();
  const before = await f.states();
  f.clock.advanceMs(-1);
  await service.expireFrozen();
  expect(await f.states()).toEqual(before);
  expect(f.setRiskState).not.toHaveBeenCalled();
  expect(await f.eventRows()).toEqual([]);
  f.clock.advanceMs(1);
  await service.expireFrozen();
  expect(f.setRiskState).toHaveBeenCalledTimes(2);
  expect(new Set(f.setRiskState.mock.calls.map(([trx]) => trx)).size).toBe(2);
  for (const subject of [first, second]) {
    const [trx, command] = f.setRiskState.mock.calls.find(
      ([, c]) => c.user_id === subject.user_id,
    )!;
    expect(trx.isTransaction).toBe(true);
    expect(command).toEqual({
      ...subject,
      state: 'normal',
      reason: null,
      reason_category: null,
      frozen_until: null,
      changed_by: 'system:freeze-expiry',
    });
    const row = (await f.states()).find((r) => r.user_id === subject.user_id)!;
    expect(row).toMatchObject({
      ...command,
      row_version: 8,
      changed_at: f.clock.now(),
      updated_at: f.clock.now(),
    });
    const event = (await f.eventRows()).find((r) => r.app_id === subject.app_id)!;
    expect(event).toMatchObject({
      app_id: subject.app_id,
      name: 'risk.state_changed',
      payload: { v: 1, data: { ...subject, from: 'frozen', to: 'normal', reason_category: null } },
    });
    const publication = f.publish.mock.calls.find(
      ([, e]) => (e as { appId: string }).appId === subject.app_id,
    )!;
    expect(publication[0]).toBe(trx);
  }
  expect(await f.eventRows()).toHaveLength(2);
  // Notification delivery belongs to its subscriber; scanning has no direct send/SMS/push.
  expect(f.send).not.toHaveBeenCalled();
});

it('[AC-B1-03j#2] appealing 即使已过期、banned、normal、无期限冻结及未到期冻结均不动', async () => {
  const service = await f.service();
  const expired = new Date(f.clock.now().getTime() - 1);
  await f.user({ state: 'appealing', frozen_until: expired });
  await f.user({ state: 'banned', frozen_until: null });
  await f.user({ state: 'normal', frozen_until: null });
  await f.user({ frozen_until: null, changed_at: new Date(f.clock.now().getTime() - 100 * DAY) });
  await f.user({ frozen_until: new Date(f.clock.now().getTime() + 1) });
  const before = await f.states();
  await service.expireFrozen();
  expect(await f.states()).toEqual(before);
  expect(f.setRiskState).not.toHaveBeenCalled();
  expect(await f.eventRows()).toEqual([]);
});

it('[AC-B1-03j#3] 重复及并发扫描至多一次迁移、一次事件，不追加版本', async () => {
  const first = await f.service();
  const second = await f.service();
  await f.user();
  await Promise.all([first.expireFrozen(), second.expireFrozen()]);
  const states = await f.states();
  const events = await f.eventRows();
  expect(states[0]).toMatchObject({ state: 'normal', row_version: 8 });
  expect(events).toHaveLength(1);
  await first.expireFrozen();
  expect(await f.states()).toEqual(states);
  expect(await f.eventRows()).toEqual(events);
});

it('[AC-B1-03j#4] CAS 冲突跳过该用户，继续其他用户；下一轮重新判定', async () => {
  const service = await f.service();
  const conflicted = await f.user();
  const healthy = await f.user();
  let conflict = true;
  f.setRiskState.mockImplementation(async (trx, command) => {
    if (command.user_id === conflicted.user_id && conflict) throw new f.RiskStateConflictError();
    return f.writeState(trx, command);
  });
  await expect(service.expireFrozen()).resolves.toBeUndefined();
  expect((await f.states()).find((r) => r.user_id === conflicted.user_id)).toMatchObject({
    state: 'frozen',
    row_version: 7,
  });
  expect((await f.states()).find((r) => r.user_id === healthy.user_id)).toMatchObject({
    state: 'normal',
    row_version: 8,
  });
  expect(await f.eventRows()).toHaveLength(1);
  conflict = false;
  await service.expireFrozen();
  expect((await f.states()).every((r) => r.state === 'normal')).toBe(true);
  expect(await f.eventRows()).toHaveLength(2);
});

it('[AC-B1-03j#5] 单用户事件写入失败回滚其状态，其余用户在独立事务成功并可重扫', async () => {
  const service = await f.service();
  const broken = await f.user();
  const healthy = await f.user();
  const publish = f.publishEvent;
  f.publish.mockImplementation(async (trx, event) => {
    await publish(trx, event);
    if ((event as { appId: string }).appId === broken.app_id)
      throw new Error('fixture-event-failure');
  });
  await expect(service.expireFrozen()).resolves.toBeUndefined();
  expect((await f.states()).find((r) => r.user_id === broken.user_id)).toMatchObject({
    state: 'frozen',
    row_version: 7,
  });
  expect((await f.states()).find((r) => r.user_id === healthy.user_id)).toMatchObject({
    state: 'normal',
    row_version: 8,
  });
  expect((await f.eventRows()).map((e) => e.app_id)).toEqual([healthy.app_id]);
  expect(new Set(f.setRiskState.mock.calls.map(([trx]) => trx)).size).toBe(2);
  f.publish.mockImplementation(publish);
  await service.expireFrozen();
  expect((await f.states()).every((r) => r.state === 'normal')).toBe(true);
  expect(await f.eventRows()).toHaveLength(2);
});

for (const change of ['extended', 'indefinite', 'appealing', 'banned'] as const) {
  it(`[AC-B1-03j#6] 候选已读但事务尚未开始时人工改为 ${change}，必须重查条件且不覆盖人工决定`, async () => {
    const service = await f.service();
    const subject = await f.user();
    const before = (await f.states())[0]!;
    const transaction = f.db.transaction.bind(f.db);
    const spy = vi.spyOn(f.db, 'transaction').mockImplementationOnce(() => {
      const builder = transaction();
      const execute = builder.execute.bind(builder);
      vi.spyOn(builder, 'execute').mockImplementation(
        async <T>(callback: (trx: Transaction<DB>) => Promise<T>) => {
          await f.db
            .updateTable('user_risk_state')
            .set({
              state: change === 'appealing' || change === 'banned' ? change : 'frozen',
              frozen_until: change === 'extended' ? new Date(f.clock.now().getTime() + DAY) : null,
              changed_by: 'human-reviewer',
              row_version: before.row_version + 1,
            })
            .where('user_id', '=', subject.user_id)
            .where('app_id', '=', subject.app_id)
            .execute();
          return execute(callback);
        },
      );
      return builder;
    });
    try {
      await service.expireFrozen();
      expect(spy).toHaveBeenCalled();
      expect(f.setRiskState).not.toHaveBeenCalled();
      expect((await f.states())[0]).toMatchObject({
        changed_by: 'human-reviewer',
        row_version: 8,
        state: change === 'appealing' || change === 'banned' ? change : 'frozen',
        frozen_until: change === 'extended' ? new Date(f.clock.now().getTime() + DAY) : null,
      });
      expect(await f.eventRows()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
}

it('[AC-B1-03j#7] 分批扫描不会因前批被解冻移出结果集而漏掉后批，查询有批量上限', async () => {
  const queryLimits: (number | undefined)[] = [];
  const db = f.db.withPlugin({
    transformQuery(args) {
      if (
        args.node.kind === 'SelectQueryNode' &&
        JSON.stringify(args.node.from).includes('user_risk_state')
      ) {
        const limit = args.node.limit?.limit;
        queryLimits.push(
          limit?.kind === 'ValueNode' ? Number((limit as ValueNode).value) : undefined,
        );
      }
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  const service = await createScan({ ...f.options, db });
  // Broad enough to cross ordinary scan batches without prescribing a production batch size.
  for (let i = 0; i < 257; i++) await f.user();
  await service.expireFrozen();
  expect((await f.states()).filter((r) => r.state !== 'normal')).toEqual([]);
  expect(await f.eventRows()).toHaveLength(257);
  // Per-user lookups can be unbounded; the initial candidate list must be bounded.
  expect(queryLimits[0]).toBeGreaterThan(0);
  expect(Number.isSafeInteger(queryLimits[0])).toBe(true);
}, 60_000);

it('[AC-B1-03j#8][AC-S1-60 ④] 不定期冻结恰满 30×24 小时才告警，每天继续提醒，状态不变且日志不含原因', async () => {
  const service = await f.service();
  const changed_at = new Date(f.clock.now().getTime() - 30 * DAY);
  const a = await f.user({ frozen_until: null, changed_at });
  const b = await f.user({ frozen_until: null, changed_at: new Date(changed_at.getTime() - DAY) });
  await f.user({ frozen_until: null, changed_at: new Date(changed_at.getTime() + 1) });
  await f.user({ frozen_until: f.clock.now(), changed_at });
  await f.user({ state: 'appealing', frozen_until: null, changed_at });
  await f.user({ state: 'banned', frozen_until: null, changed_at });
  await f.user({ state: 'normal', frozen_until: null, changed_at });
  const states = await f.states();
  await service.dailyAlerts();
  const logs = warnings(f.lines, 'risk_freeze_indefinite_overdue');
  expect(logs).toHaveLength(2);
  expect(logs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ...a, changed_at: changed_at.toISOString(), days: 30 }),
      expect.objectContaining({
        ...b,
        changed_at: new Date(changed_at.getTime() - DAY).toISOString(),
        days: 31,
      }),
    ]),
  );
  f.lines.length = 0;
  f.clock.advanceMs(DAY);
  await service.dailyAlerts();
  const next = warnings(f.lines, 'risk_freeze_indefinite_overdue');
  expect(next).toHaveLength(3);
  expect(next.find((r) => r['user_id'] === a.user_id)).toMatchObject({ days: 31 });
  expect(await f.states()).toEqual(states);
  expect(f.setRiskState).not.toHaveBeenCalled();
  expect(await f.eventRows()).toEqual([]);
  expect(f.lines.join('')).not.toContain(PRIVATE_REASON);
  for (const line of [...logs, ...next]) {
    expect(line).not.toHaveProperty('reason');
    expect(line).not.toHaveProperty('user');
  }
});

it('[AC-B1-03j#9] 申诉恰到第 3 个工作日 24:00 不告警，晚一毫秒才告警；已结案不告警', async () => {
  const service = await f.service();
  // deadline_at is supplied by B1-03i; this scanner must use the persisted deadline verbatim.
  f.clock.set('2026-10-15T00:00:00+08:00');
  const a = await f.user({ state: 'appealing', frozen_until: null });
  const b = await f.user({ frozen_until: null });
  const deadline = f.clock.now();
  const account = await f.appeal(a, { deadline_at: deadline });
  const order = await f.appeal(b, { target_type: 'order', deadline_at: deadline });
  const request = await f.appeal(b, { target_type: 'blocked_request', deadline_at: deadline });
  await f.appeal(a, { status: 'upheld', deadline_at: new Date(deadline.getTime() - DAY) });
  await f.appeal(a, { status: 'revoked', deadline_at: new Date(deadline.getTime() - DAY) });
  await f.appeal(b, { target_type: 'order', deadline_at: new Date(deadline.getTime() + DAY) });
  const appeals = await f.appeals();
  const states = await f.states();
  await service.dailyAlerts();
  expect(warnings(f.lines, 'risk_appeal_overdue')).toEqual([]);
  f.clock.advanceMs(1);
  await service.dailyAlerts();
  const logs = warnings(f.lines, 'risk_appeal_overdue');
  expect(logs).toHaveLength(3);
  for (const [appeal_id, app_id, target_type] of [
    [account, a.app_id, 'account'],
    [order, b.app_id, 'order'],
    [request, b.app_id, 'blocked_request'],
  ]) {
    expect(logs).toContainEqual(
      expect.objectContaining({
        appeal_id,
        app_id,
        target_type,
        deadline_at: deadline.toISOString(),
      }),
    );
  }
  expect(await f.appeals()).toEqual(appeals);
  expect(await f.states()).toEqual(states);
  expect(f.setRiskState).not.toHaveBeenCalled();
  expect(await f.eventRows()).toEqual([]);
  expect(f.lines.join('')).not.toContain(PRIVATE_CONTENT);
  for (const log of logs) {
    for (const field of ['content', 'phone', 'user', 'reason'])
      expect(log).not.toHaveProperty(field);
  }
});

it('[AC-B1-03j#10] 同一次 daily-alerts 同时扫描跨 app 的不定期冻结和超时申诉', async () => {
  const service = await f.service();
  const a = await f.user({
    frozen_until: null,
    changed_at: new Date(f.clock.now().getTime() - 30 * DAY),
  });
  const b = await f.user({ state: 'appealing', frozen_until: null });
  const id = await f.appeal(b, { deadline_at: new Date(f.clock.now().getTime() - 1) });
  await service.dailyAlerts();
  expect(warnings(f.lines, 'risk_freeze_indefinite_overdue')).toEqual([expect.objectContaining(a)]);
  expect(warnings(f.lines, 'risk_appeal_overdue')).toEqual([
    expect.objectContaining({ app_id: b.app_id, appeal_id: id }),
  ]);
  expect(f.setRiskState).not.toHaveBeenCalled();
});

it('[AC-B1-03j#11] 候选查询失败向上抛错，不能伪装成成功空扫描', async () => {
  const service = await f.service();
  // Test-owned query plugin fails before any real query, without destroying the shared pool.
  const unavailable = f.db.withPlugin({
    transformQuery() {
      throw new Error('fixture-db-unavailable');
    },
    async transformResult(args) {
      return args.result;
    },
  });
  const failing = await createScan({ ...f.options, db: unavailable });
  await expect(failing.expireFrozen()).rejects.toThrow('fixture-db-unavailable');
  await expect(failing.dailyAlerts()).rejects.toThrow('fixture-db-unavailable');
  await expect(service.expireFrozen()).resolves.toBeUndefined();
  expect(f.setRiskState).not.toHaveBeenCalled();
  expect(
    (await sql<{ count: number }>`SELECT count(*)::int AS count FROM app.event_log`.execute(f.db))
      .rows[0]!.count,
  ).toBe(0);
});

it('[AC-B1-03j#18] handler 按任务名实际执行对应扫描，解冻不跑告警，告警不做解冻', async () => {
  const service = await f.service();
  const expiring = await f.user();
  const indefinite = await f.user({
    frozen_until: null,
    changed_at: new Date(f.clock.now().getTime() - 30 * DAY),
  });
  const appealing = await f.user({ state: 'appealing', frozen_until: null });
  const appeal_id = await f.appeal(appealing, {
    deadline_at: new Date(f.clock.now().getTime() - 1),
  });
  const before = await f.states();
  await service.handle(job('daily-alerts'));
  expect(await f.states()).toEqual(before);
  expect(warnings(f.lines, 'risk_freeze_indefinite_overdue')).toEqual([
    expect.objectContaining(indefinite),
  ]);
  expect(warnings(f.lines, 'risk_appeal_overdue')).toEqual([
    expect.objectContaining({ appeal_id }),
  ]);
  expect(f.setRiskState).not.toHaveBeenCalled();
  f.lines.length = 0;
  await service.handle(job('freeze-expiry'));
  expect((await f.states()).find((r) => r.user_id === expiring.user_id)).toMatchObject({
    state: 'normal',
    row_version: 8,
  });
  expect(warnings(f.lines, 'risk_freeze_indefinite_overdue')).toEqual([]);
  expect(warnings(f.lines, 'risk_appeal_overdue')).toEqual([]);
  expect(await f.eventRows()).toHaveLength(1);
  expect(f.send.mock.calls.map(([, name]) => name)).toEqual(['daily-alerts', 'freeze-expiry']);
});
