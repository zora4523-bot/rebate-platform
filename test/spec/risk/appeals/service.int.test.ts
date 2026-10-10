import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedUser } from '../../identity/registration/kit.ts';
import { closeKit, fixture, openKit, publicAppeal, success, type Kit } from './service-kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
});

for (const state of ['banned', 'frozen'] as const) {
  it(`[AC-B1-03i#7][AC-S1-60 ⑤] ${state} 账户申诉经状态服务与事件同事务提交，忽略外传 target_id`, async () => {
    const f = await fixture(kit, state);
    const other = await seedUser(f.db, f.subject.app_id);
    const service = await f.service();
    const content = '  原文\n请复核🙂  ';
    const result = await f.db.transaction().execute(async (trx) => {
      const data = success(
        await service.submit(trx, f.subject, { target_type: 'account', target_id: other, content }),
      );
      expect(f.setRiskState).toHaveBeenCalledTimes(1);
      expect(f.setRiskState.mock.calls[0]![0]).toBe(trx);
      expect(f.publish).toHaveBeenCalledTimes(1);
      expect(f.publish.mock.calls[0]![0]).toBe(trx);
      expect(await f.appeals()).toEqual([]);
      expect(await f.rows()).toEqual(f.beforeRows);
      expect(await f.eventRows()).toEqual(f.beforeEvents);
      return data;
    });
    publicAppeal(result);
    expect(result).toMatchObject({
      target_type: 'account',
      target_id: f.subject.user_id,
      content,
      status: 'processing',
      closed_at: null,
    });
    const rows = await f.appeals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.appeal_id,
      ...f.subject,
      target_id: f.subject.user_id,
      target_type: 'account',
      content,
      prev_risk_state: state,
      status: 'processing',
      handler_id: null,
      closed_at: null,
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    });
    expect(new Date(result.created_at)).toEqual(f.clock.now());
    expect(rows[0]!.deadline_at.getTime()).toBeGreaterThan(f.clock.now().getTime());
    expect(rows[0]!.deadline_at.toISOString().slice(11)).toBe('16:00:00.000Z');
    expect(await f.rows()).toEqual([
      {
        ...f.beforeRows[0],
        state: 'appealing',
        changed_by: `user:${f.subject.user_id}`,
        changed_at: f.clock.now(),
        updated_at: f.clock.now(),
        row_version: f.beforeRows[0]!.row_version + 1,
      },
    ]);
    const events = await f.eventRows();
    expect(events).toHaveLength(f.beforeEvents.length + 1);
    expect(events.find((e) => !f.beforeEvents.some((old) => old.id === e.id))!.payload).toEqual({
      v: 1,
      data: {
        ...f.subject,
        from: state,
        to: 'appealing',
        reason_category: f.command.reason_category,
      },
    });
  });
}

it('[AC-B1-03i#8][AC-S1-60 ⑤] 处理中再次提交保留原内容、原截止时间，不改版本、不发事件', async () => {
  const f = await fixture(kit);
  const service = await f.service();
  const first = success(await f.submit(service));
  const appeals = await f.appeals();
  const states = await f.rows();
  const events = await f.eventRows();
  f.clock.advanceMs(3600_000);
  expect(
    success(
      await f.submit(service, {
        target_type: 'account',
        target_id: randomUUID(),
        content: '第二次内容',
      }),
    ),
  ).toEqual(first);
  expect(await f.appeals()).toEqual(appeals);
  expect(await f.rows()).toEqual(states);
  expect(await f.eventRows()).toEqual(events);
  expect(f.setRiskState).toHaveBeenCalledTimes(1);
});

for (const state of ['normal', 'absent', 'appealing'] as const) {
  it(`[AC-B1-03i#9] ${state} 且无处理中账户单返回 20001，无写入`, async () => {
    const f = await fixture(kit, state);
    const service = await f.service();
    expect(await f.submit(service)).toMatchObject({ code: 20001 });
    expect(await f.appeals()).toEqual([]);
    expect(await f.rows()).toEqual(f.beforeRows);
    expect(await f.eventRows()).toEqual(f.beforeEvents);
    expect(f.setRiskState).not.toHaveBeenCalled();
  });
}

for (const body of [
  { target_type: 'order' as const, content: '订单未接入' },
  { target_type: 'order' as const, target_id: randomUUID(), content: '订单未接入' },
]) {
  it(`[AC-B1-03i#10] 订单申诉${body.target_id ? '有' : '无'} target_id 均拒绝且不写入`, async () => {
    const f = await fixture(kit);
    const service = await f.service();
    expect(await f.submit(service, body)).toMatchObject({ code: 20001 });
    expect(await f.appeals()).toEqual([]);
    expect(await f.rows()).toEqual(f.beforeRows);
    expect(await f.eventRows()).toEqual(f.beforeEvents);
  });
}

it('[AC-B1-03i#11] 两个服务实例并发提交，均返回同一单，只有一次状态迁移及事件', async () => {
  const f = await fixture(kit);
  const serviceA = await f.service();
  const serviceB = await f.service();
  const body = { target_type: 'account' as const, content: '请复核' };
  const a = await f.db.startTransaction().execute();
  try {
    await sql`SET LOCAL statement_timeout = '10s'`.execute(a);
    // A 已完成业务写入，但保持事务未提交；B 必须在另一连接上等待 A。
    const first = success(await serviceA.submit(a, f.subject, body));
    let secondPid: number | undefined;
    const pending = f.db
      .transaction()
      .execute(async (b) => {
        await sql`SET LOCAL statement_timeout = '10s'`.execute(b);
        const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(b);
        secondPid = pid.rows[0]!.pid;
        return serviceB.submit(b, f.subject, body);
      })
      .then(
        (result) => ({ status: 'fulfilled' as const, result }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
    try {
      // 以数据库实际阻塞关系为栅栏，不靠延时猜测两个提交是否交错。
      await expect
        .poll(
          async () => {
            if (secondPid === undefined) return false;
            const waiting = await sql<{ blocked: boolean }>`
                SELECT pg_backend_pid() = ANY(pg_blocking_pids(${secondPid})) AS blocked
              `.execute(a);
            return waiting.rows[0]!.blocked;
          },
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      await a.commit().execute();
      expect(await pending).toEqual({ status: 'fulfilled', result: { code: 0, data: first } });
    } finally {
      // 即使栅栏断言失败，也先释放 A，再等 B 结束，避免遗留持锁事务。
      if (!a.isCommitted && !a.isRolledBack) await a.rollback().execute();
      await pending;
    }
    expect(await f.appeals()).toHaveLength(1);
    expect(await f.appeals()).toMatchObject([{ id: first.appeal_id, status: 'processing' }]);
    expect(await f.rows()).toMatchObject([
      { state: 'appealing', row_version: f.beforeRows[0]!.row_version + 1 },
    ]);
    expect(await f.eventRows()).toHaveLength(f.beforeEvents.length + 1);
    expect(f.setRiskState).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledTimes(1);
  } finally {
    if (!a.isCommitted && !a.isRolledBack) await a.rollback().execute();
  }
}, 30_000);

for (const failure of ['caller', 'state', 'event'] as const) {
  it(`[AC-B1-03i#12] ${failure} 失败使申诉、状态、事件整体回滚`, async () => {
    const f = await fixture(kit);
    const service = await f.service();
    const abort = new Error(`fixture-${failure}-rollback`);
    if (failure === 'state') f.setRiskState.mockRejectedValueOnce(abort);
    if (failure === 'event') f.publish.mockRejectedValueOnce(abort);
    await expect(
      f.db.transaction().execute(async (trx) => {
        success(
          await service.submit(trx, f.subject, { target_type: 'account', content: '事务回滚' }),
        );
        throw abort;
      }),
    ).rejects.toBe(abort);
    expect(await f.appeals()).toEqual([]);
    expect(await f.rows()).toEqual(f.beforeRows);
    expect(await f.eventRows()).toEqual(f.beforeEvents);
  });
}

it('[AC-B1-03i#13] 受理读取当前事务的数据库状态，不使用预热 normal 缓存', async () => {
  const f = await fixture(kit, 'normal');
  await f.riskState.readRiskState(f.subject);
  // Direct fixture update simulates an already committed change by another process.
  await f.db
    .withSchema('app')
    .updateTable('user_risk_state')
    .set({ state: 'banned' })
    .where('app_id', '=', f.subject.app_id)
    .where('user_id', '=', f.subject.user_id)
    .execute();
  expect((await f.riskState.readRiskState(f.subject)).state).toBe('normal');
  const service = await f.service();
  success(await f.submit(service));
  expect(await f.appeals()).toMatchObject([{ prev_risk_state: 'banned' }]);
  expect(await f.rows()).toMatchObject([{ state: 'appealing' }]);
});

it('[AC-B1-03i#14] 相同 user_id 但不同 app_id 不得受理或影响原账户', async () => {
  const f = await fixture(kit);
  const service = await f.service();
  expect(
    await f.submit(
      service,
      { target_type: 'account', content: '跨品牌' },
      { ...f.subject, app_id: 'foreign_app' },
    ),
  ).toMatchObject({ code: 20001 });
  expect(await f.appeals()).toEqual([]);
  expect(await f.rows()).toEqual(f.beforeRows);
  expect(await f.eventRows()).toEqual(f.beforeEvents);
  expect(
    await f.db
      .withSchema('app')
      .selectFrom('appeals')
      .selectAll()
      .where('app_id', '=', 'foreign_app')
      .execute(),
  ).toEqual([]);
});

for (const failedConfig of [false, true]) {
  it(`[AC-B1-03i#28] 提交实际存入注入时钟与${failedConfig ? '降级' : '配置'}日历的截止时间`, async () => {
    const f = await fixture(kit);
    f.clock.set('2026-11-02T07:00:00.000Z');
    if (failedConfig) f.configValue.mockRejectedValue(new Error('private-calendar-outage'));
    else {
      f.values.set('calendar.cn_holidays.2026', [
        '2026-11-03',
        '2026-11-04',
        '2026-11-05',
        '2026-11-06',
      ]);
      f.values.set('calendar.cn_makeup_workdays.2026', ['2026-11-07']);
    }
    const service = await f.service();
    publicAppeal(success(await f.submit(service)));
    const row = (await f.appeals())[0]!;
    expect(row.created_at).toEqual(f.clock.now());
    expect(row.deadline_at.toISOString()).toBe(
      failedConfig ? '2026-11-05T16:00:00.000Z' : '2026-11-10T16:00:00.000Z',
    );
    for (const key of ['calendar.cn_holidays.2026', 'calendar.cn_makeup_workdays.2026']) {
      if (!failedConfig) expect(f.configValue).toHaveBeenCalledWith(f.subject.app_id, key);
    }
    if (failedConfig) {
      const warnings = f.lines.map((line) => JSON.parse(line) as { level: number; msg?: string });
      expect(
        warnings.filter((line) => line.level === 40 && line.msg === 'appeal_calendar_unconfigured'),
      ).toHaveLength(1);
      expect(f.lines.join('')).not.toContain('private-calendar-outage');
    }
  });
}

it('[AC-B1-03i#29] 已结案历史单不被当作处理中单；新单记当前 frozen，历史单不变', async () => {
  const f = await fixture(kit, 'frozen');
  const id = randomUUID();
  await f.db
    .withSchema('app')
    .insertInto('appeals')
    .values({
      id,
      ...f.subject,
      target_type: 'account',
      target_id: f.subject.user_id,
      status: 'upheld',
      content: '历史封禁申诉',
      prev_risk_state: 'banned',
      deadline_at: f.clock.now(),
      closed_at: f.clock.now(),
      handler_id: 'fixture-handler',
    })
    .execute();
  const before = (await f.appeals())[0];
  const service = await f.service();
  const result = success(await f.submit(service));
  expect(result.appeal_id).not.toBe(id);
  const rows = await f.appeals();
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.id === id)).toEqual(before);
  expect(rows.find((row) => row.id === result.appeal_id)).toMatchObject({
    prev_risk_state: 'frozen',
    status: 'processing',
  });
});
