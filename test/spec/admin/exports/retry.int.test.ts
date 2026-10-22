import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import * as domain from '@couli/domain';
import { expect, it, vi } from 'vitest';
import { seed } from '../accounts/kit.ts';
import { error, harness, ok, RETRY, setup, type View } from './kit.ts';

const h = harness(createTestDatabase, acquireTestRedis);

it.each(['invalid', 'expired'] as const)(
  '[AC-B1-34f#38] 明文重试拒绝 %s 令牌，任务和审计均不变',
  async (kind) => {
    const f = await setup(h);
    const task = await f.task({ masked: false });
    let token = 'invalid-step-up';
    if (kind === 'expired') {
      token = (await f.issue()).step_up_token;
      f.clock.advanceMs(300_000);
    }
    await error(
      await f.retry(task.public_id, { reason: '复核' }, token),
      10003,
      { tier: 'totp' },
      RETRY,
    );
    expect(await f.read(task.id)).toEqual(task);
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.audits()).toEqual([]);
  },
);

it('[AC-B1-34f#24] failed 重试保留身份和筛选，清空进度与失败原因、CAS 版本递增并审计入队', async () => {
  const f = await setup(h);
  const task = await f.task({ filters: { risk_state: 'frozen' }, progress: 77, row_version: 9 });
  const transition = vi.spyOn(domain, 'transitionExportTask');
  const result = await ok<View>(await f.retry(task.public_id, {}, 'ignored-invalid-token'), RETRY);
  expect(result).toMatchObject({
    id: task.public_id,
    status: 'pending',
    progress: null,
    failure_reason: null,
    masked: true,
    resource: 'users',
    created_by: f.actor.id,
  });
  expect(await f.read(task.id)).toMatchObject({
    status: 'pending',
    progress: null,
    failure_reason: null,
    row_version: 10,
    resource: task.resource,
    filters: task.filters,
    masked: task.masked,
    public_id: task.public_id,
    created_by: task.created_by,
    created_at: task.created_at,
    updated_at: f.clock.now(),
  });
  expect(transition).toHaveBeenCalledWith('failed', 'RETRY');
  expect(f.send).toHaveBeenCalledExactlyOnceWith(
    'export',
    'generate',
    { appId: f.appId, taskId: task.id },
    expect.objectContaining({ trx: expect.anything() }),
  );
  expect(await f.audits()).toEqual([
    expect.objectContaining({
      action: 'export_retry',
      admin_id: f.actor.id,
      at: f.clock.now(),
      after: expect.objectContaining({ task_id: task.public_id, resource: 'users', masked: true }),
    }),
  ]);
});

it('[AC-B1-34f#25] 两个并发重试只有一个成功、一次入队和一次审计，另一方见 pending', async () => {
  const f = await setup(h);
  const task = await f.task();
  const responses = await Promise.all([f.retry(task.public_id), f.retry(task.public_id)]);
  expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 422]);
  await ok<View>(
    responses.find((response) => response.statusCode === 200)!,
    RETRY,
  );
  await error(
    responses.find((response) => response.statusCode === 422)!,
    30417,
    { status: 'pending' },
    RETRY,
  );
  expect(f.send.mock.calls.filter(([queue]) => queue === 'export')).toHaveLength(1);
  expect(await f.audits()).toHaveLength(1);
  expect(await f.read(task.id)).toMatchObject({
    status: 'pending',
    row_version: task.row_version + 1,
  });
});

it('[AC-B1-34f#26] 重试入队失败回滚，保持 failed 与原版本，不消耗明文令牌', async () => {
  const f = await setup(h);
  const task = await f.task({ masked: false, progress: 44 });
  const token = (await f.issue()).step_up_token;
  f.send.mockRejectedValueOnce(new Error('synthetic queue failure'));
  await error(
    await f.retry(task.public_id, { reason: '重新核对' }, token),
    50001,
    undefined,
    RETRY,
  );
  expect(await f.read(task.id)).toEqual(task);
  expect(await f.audits()).toEqual([]);
  expect(
    (await ok<View>(await f.retry(task.public_id, { reason: '重新核对' }, token), RETRY)).status,
  ).toBe('pending');
});

it.each(['pending', 'running', 'done', 'expired', 'cancelled'] as const)(
  '[AC-B1-34f#27] 只有 failed 可以重试：%s 返回 30417',
  async (status) => {
    const f = await setup(h);
    const task = await f.task({ status });
    await error(await f.retry(task.public_id), 30417, { status }, RETRY);
    expect(await f.read(task.id)).toEqual(task);
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.audits()).toEqual([]);
  },
);

it.each(['other', 'unknown', 'cross_app', 'super_other'] as const)(
  '[AC-B1-34f#28] 重试防探测 %s，audit.view_all 和超管不突破创建人限制',
  async (kind) => {
    const f = await setup(
      h,
      ['export', 'user.list', 'pii.reveal_phone', 'audit.view_all'],
      kind === 'super_other',
    );
    const other = await seed(h, kind === 'cross_app' ? 'foreign_retry' : f.appId);
    const task = await f.task({
      created_by: other.id,
      app_id: other.appId,
      status: 'cancelled',
      masked: false,
    });
    const id = kind === 'unknown' ? 'exp_UnknownRetryTask' : task.public_id;
    await error(await f.retry(id), 20001, { fields: ['id'] }, RETRY);
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.audits()).toEqual([]);
  },
);

// CT-24k explicitly differs here from download: revoked source/pii points are 10403 on retry.
it.each(['export', 'user.list', 'pii.reveal_phone'])(
  '[AC-B1-34f#29] 重试复核当前权限，撤销 %s 返回契约规定的 10403',
  async (point) => {
    const f = await setup(h);
    const task = await f.task({ masked: false });
    const token = (await f.issue()).step_up_token;
    await f.revoke(point);
    await error(
      await f.retry(task.public_id, { reason: '重新核对' }, token),
      10403,
      { reason: 'admin_permission_denied' },
      RETRY,
    );
    expect(await f.read(task.id)).toEqual(task);
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.audits()).toEqual([]);
  },
);

it('[AC-B1-34f#30] 明文重试需新理由和令牌；成功只消费一次，分别写重试与明文审计', async () => {
  const f = await setup(h);
  const task = await f.task({ masked: false });
  await error(
    await f.retry(task.public_id, { reason: '本次理由' }),
    10003,
    { tier: 'totp' },
    RETRY,
  );
  const token = (await f.issue()).step_up_token;
  await error(await f.retry(task.public_id, {}, token), 20001, { fields: ['reason'] }, RETRY);
  const view = await ok<View>(await f.retry(task.public_id, { reason: '本次理由' }, token), RETRY);
  expect(view).toMatchObject({ id: task.public_id, status: 'pending', masked: false });
  expect(f.guarded.mock.calls.map(([input]) => input.permission)).toContain('pii.reveal_phone');
  const audits = await f.audits();
  expect(audits.map((row) => row.action).sort()).toEqual(['export_retry', 'export_unmasked']);
  expect(audits.find((row) => row.action === 'export_unmasked')).toMatchObject({
    admin_id: f.actor.id,
    after: expect.objectContaining({
      task_id: task.public_id,
      resource: 'users',
      reason: '本次理由',
    }),
  });
  const another = await f.task({ masked: false });
  await error(
    await f.retry(another.public_id, { reason: '再试' }, token),
    10003,
    { tier: 'totp' },
    RETRY,
  );
  const fresh = (await f.issue()).step_up_token;
  expect(
    (await ok<View>(await f.retry(another.public_id, { reason: '新理由' }, fresh), RETRY)).status,
  ).toBe('pending');
});

it.each(['', '理'.repeat(201)])(
  '[AC-B1-34f#31] 明文重试校验理由长度 %j，失败不消耗令牌',
  async (reason) => {
    const f = await setup(h);
    const task = await f.task({ masked: false });
    const token = (await f.issue()).step_up_token;
    await error(
      await f.retry(task.public_id, { reason }, token),
      20001,
      { fields: ['reason'] },
      RETRY,
    );
    expect(await f.read(task.id)).toEqual(task);
    expect(
      (await ok<View>(await f.retry(task.public_id, { reason: '复核' }, token), RETRY)).status,
    ).toBe('pending');
  },
);

it('[AC-B1-34f#32] 脱敏重试拒绝理由、忽略动态码；audit_logs 重试不要求 user.list', async () => {
  const f = await setup(h, ['export']);
  const task = await f.task({ resource: 'audit_logs' });
  await error(
    await f.retry(task.public_id, { reason: '多余理由' }),
    20001,
    { fields: ['reason'] },
    RETRY,
  );
  expect(
    (await ok<View>(await f.retry(task.public_id, {}, 'invalid-but-ignored'), RETRY)).masked,
  ).toBe(true);
  expect(await f.audits()).toHaveLength(1);
  expect(f.guarded.mock.calls.map(([input]) => input.permission)).not.toContain('pii.reveal_phone');
});
