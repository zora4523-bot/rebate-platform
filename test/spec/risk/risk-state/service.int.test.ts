import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedUser } from '../../identity/registration/kit.ts';
import { closeKit, fixture, openKit, type Kit } from './service-kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
});

it('[AC-B1-03h#8][BR-ID-36] 无行 normal；插入与更新只影响目标行，原因类别/期限/操作者/注入时间持久化且 CAS 递增', async () => {
  const f = await fixture(kit);
  const service = f.service();
  expect(await service.readRiskState(f.subject)).toEqual({
    state: 'normal',
    reason_category: null,
    frozen_until: null,
  });
  const another = await seedUser(f.db, f.subject.app_id);
  await f.db
    .transaction()
    .execute((trx) => service.setRiskState(trx, { ...f.command, user_id: another }));
  const untouched = (await f.rows()).find((r) => r.user_id === another);
  const until = new Date(f.clock.now().getTime() + 86_400_000);
  await f.db.transaction().execute((trx) =>
    service.setRiskState(trx, {
      ...f.command,
      state: 'frozen',
      frozen_until: until,
      reason_category: 'account_security',
    }),
  );
  const first = (await f.rows()).find((r) => r.user_id === f.subject.user_id)!;
  expect(first).toMatchObject({
    ...f.subject,
    state: 'frozen',
    frozen_until: until,
    reason_category: 'account_security',
    reason: f.command.reason,
    changed_by: f.command.changed_by,
    changed_at: f.clock.now(),
    row_version: 0,
  });
  f.clock.advanceMs(1234);
  await f.db
    .transaction()
    .execute((trx) => service.setRiskState(trx, { ...f.command, changed_by: 'second_operator' }));
  const rows = await f.rows();
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.user_id === another)).toEqual(untouched);
  expect(rows.find((r) => r.user_id === f.subject.user_id)).toMatchObject({
    ...f.subject,
    state: 'banned',
    frozen_until: null,
    reason_category: 'malicious_rights',
    changed_by: 'second_operator',
    changed_at: f.clock.now(),
    row_version: first.row_version + 1,
  });
  const updates = f.queries.filter(
    (node) =>
      node.kind === 'UpdateQueryNode' && JSON.stringify(node.table).includes('user_risk_state'),
  );
  expect(updates.length).toBeGreaterThan(0);
  for (const update of updates) {
    if (update.kind !== 'UpdateQueryNode') continue;
    expect(JSON.stringify(update.where)).toContain('row_version');
    expect(JSON.stringify(update.where)).toContain('user_id');
    expect(JSON.stringify(update.where)).toContain('app_id');
  }
});

it('[AC-B1-03h#9][BR-ID-31/36] 读服务只暴露三字段；不定期冻结、过期冻结、封禁均不自行到期恢复', async () => {
  const f = await fixture(kit);
  const service = f.service();
  for (const command of [
    { ...f.command, state: 'frozen' as const, frozen_until: null },
    { ...f.command, state: 'frozen' as const, frozen_until: new Date(f.clock.now().getTime() - 1) },
    f.command,
  ]) {
    await f.db.transaction().execute((trx) => service.setRiskState(trx, command));
    expect(await service.readRiskState(f.subject, { fresh: true })).toEqual({
      state: command.state,
      reason_category: command.reason_category,
      frozen_until: command.frozen_until,
    });
  }
  f.clock.advanceMs(31 * 86_400_000);
  expect(await service.readRiskState(f.subject, { fresh: true })).toEqual({
    state: 'banned',
    reason_category: f.command.reason_category,
    frozen_until: null,
  });
});

it('[AC-B1-03h#10][BR-ID-01] 同一服务 normal→banned→normal，提交后不推进时钟就失效已有缓存', async () => {
  const f = await fixture(kit);
  const service = f.service();
  expect((await service.readRiskState(f.subject)).state).toBe('normal');
  for (const state of ['banned', 'normal'] as const) {
    await f.db.transaction().execute((trx) =>
      service.setRiskState(trx, {
        ...f.command,
        state,
        reason_category: state === 'normal' ? null : 'other',
      }),
    );
    expect((await service.readRiskState(f.subject)).state).toBe(state);
  }
});

it('[AC-B1-03h#11][BR-ID-36] 发布 risk.state_changed 使用调用者事务，payload 精确限定，提交后事件和状态各一行', async () => {
  const f = await fixture(kit);
  const service = f.service();
  await f.db.transaction().execute(async (trx) => {
    await service.setRiskState(trx, f.command);
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.publish.mock.calls[0]![0]).toBe(trx);
    expect(f.publish.mock.calls[0]![1]).toMatchObject({
      appId: f.subject.app_id,
      name: 'risk.state_changed',
    });
    expect(f.publish.mock.calls[0]![1].payload).toEqual({
      ...f.subject,
      from: 'normal',
      to: 'banned',
      reason_category: 'malicious_rights',
    });
    expect(
      await trx
        .selectFrom('event_log')
        .selectAll()
        .where('app_id', '=', f.subject.app_id)
        .execute(),
    ).toHaveLength(1);
    expect(await f.eventRows()).toHaveLength(0); // second connection sees no uncommitted event
    expect(await f.rows()).toHaveLength(0);
  });
  expect(await f.rows()).toHaveLength(1);
  const events = await f.eventRows();
  expect(events).toHaveLength(1);
  expect(events[0]!.payload).toEqual({
    v: 1,
    data: { ...f.subject, from: 'normal', to: 'banned', reason_category: 'malicious_rights' },
  });
  // event_log rows carry bigint columns: stringify with a bigint-safe replacer
  expect(
    JSON.stringify(events, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  ).not.toContain(f.command.reason);
});

it('[AC-B1-03h#12][BR-ID-36] 调用者回滚，状态和 event_log 都不提交，缓存不泄漏回滚状态', async () => {
  const f = await fixture(kit);
  const service = f.service();
  await service.readRiskState(f.subject);
  const abort = new Error('fixture rollback');
  await expect(
    f.db.transaction().execute(async (trx) => {
      await service.setRiskState(trx, f.command);
      expect(f.publish.mock.calls[0]![0]).toBe(trx);
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await f.rows()).toHaveLength(0);
  expect(await f.eventRows()).toHaveLength(0);
  expect((await service.readRiskState(f.subject)).state).toBe('normal');
});

it('[AC-B1-03h#13][BR-ID-36] 事件发布失败使状态写入回滚，不能吞掉失败', async () => {
  const f = await fixture(kit);
  const service = f.service();
  const failed = new Error('fixture event failure');
  f.publish.mockRejectedValueOnce(failed);
  await expect(
    f.db.transaction().execute((trx) => service.setRiskState(trx, f.command)),
  ).rejects.toBe(failed);
  expect(await f.rows()).toHaveLength(0);
  expect(await f.eventRows()).toHaveLength(0);
});

it('[AC-B1-03h#14][BR-ID-01/36] app_id 不匹配不能读到另一品牌的状态，也不能跨品牌更新同 user_id', async () => {
  const f = await fixture(kit);
  const service = f.service();
  await f.db.transaction().execute((trx) => service.setRiskState(trx, f.command));
  const before = await f.rows();
  const foreign = {
    ...f.subject,
    app_id: `other_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
  };
  expect(await service.readRiskState(foreign, { fresh: true })).toEqual({
    state: 'normal',
    reason_category: null,
    frozen_until: null,
  });
  await expect(
    f.db.transaction().execute((trx) =>
      service.setRiskState(trx, {
        ...f.command,
        ...foreign,
        state: 'normal',
        reason_category: null,
      }),
    ),
  ).rejects.toBeInstanceOf(Error);
  expect(await f.rows()).toEqual(before);
  expect(await f.eventRows()).toHaveLength(1);
});

it('[AC-B1-03h#15][BR-ID-36] 并发状态变更无丢失更新；每个成功写入对应一个版本和真实 from→to 事件', async () => {
  const f = await fixture(kit);
  const service = f.service();
  await f.db
    .transaction()
    .execute((trx) =>
      service.setRiskState(trx, { ...f.command, state: 'normal', reason_category: null }),
    );
  const results = await Promise.allSettled(
    (['frozen', 'banned'] as const).map((state) =>
      f.db.transaction().execute((trx) => service.setRiskState(trx, { ...f.command, state })),
    ),
  );
  const successes = results.filter((r) => r.status === 'fulfilled').length;
  expect(successes).toBeGreaterThan(0);
  const rows = await f.rows();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.row_version).toBe(successes);
  const payloads = (await f.eventRows())
    .map((e) => e.payload as { data: { from: string; to: string } })
    .filter((p) => p.data.to !== 'normal');
  expect(payloads).toHaveLength(successes);
  const first = payloads.find((p) => p.data.from === 'normal');
  expect(first).toBeDefined();
  if (successes === 2) {
    const second = payloads.find((p) => p !== first)!;
    expect(second.data.from).toBe(first!.data.to);
    expect(rows[0]!.state).toBe(second.data.to);
  } else expect(rows[0]!.state).toBe(first!.data.to);
});

it('[AC-B1-03h#25][BR-ID-01] 写事务提交前的并发旧值读取，不能在提交后留下 60 秒旧缓存', async () => {
  const f = await fixture(kit);
  const service = f.service();
  expect((await service.readRiskState(f.subject)).state).toBe('normal');
  await f.db.transaction().execute(async (trx) => {
    await service.setRiskState(trx, f.command);
    // Another request still sees committed normal. It must not repopulate a lasting stale
    // cache after the setter's early invalidation; do not cache an uncommitted banned either.
    expect((await service.readRiskState(f.subject)).state).toBe('normal');
  });
  expect((await service.readRiskState(f.subject)).state).toBe('banned');
});
