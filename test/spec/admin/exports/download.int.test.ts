import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { seed } from '../accounts/kit.ts';
import { DOWNLOAD, error, harness, ok, setup, text, type Download } from './kit.ts';

const h = harness(createTestDatabase, acquireTestRedis);

it.each(['users', 'audit_logs'] as const)(
  '[AC-B1-34f#39] 脱敏 %s 下载不要求 pii 权限，审计来源不要求 user.list',
  async (resource) => {
    const f = await setup(h, resource === 'users' ? ['export', 'user.list'] : ['export']);
    const task = await f.done(3_600_000, true, { resource });
    expect((await ok<Download>(await f.download(task.public_id), DOWNLOAD, 'get')).url).toMatch(
      /^https?:/,
    );
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(await f.audits()).toHaveLength(1);
  },
);

it('[AC-B1-34f#35] 下载审计写入失败必须阻止链接响应', async () => {
  const db = h.db.withPlugin({
    transformQuery({ node }) {
      if (node.kind === 'InsertQueryNode' && text(node).includes('export_download')) {
        throw new Error('synthetic audit write failure');
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const f = await setup({ ...h, db });
  const task = await f.done();
  const response = await f.download(task.public_id);
  await error(response, 50001, undefined, DOWNLOAD, 'get');
  expect(text(response.json())).not.toContain('signature=');
  expect(await f.audits()).toEqual([]);
});

it.each([3_600_000, 300_000, 299_999, 1])(
  '[AC-B1-34f#16] 下载剩余 %i ms，现签 min(5 分钟, 剩余)、no-store、先审计',
  async (remaining) => {
    const f = await setup(h);
    const task = await f.done(remaining, false);
    const before = f.clock.now().getTime();
    const response = await f.download(task.public_id);
    const data = await ok<Download>(response, DOWNLOAD, 'get');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(new Date(data.url_expires_at).getTime()).toBe(before + Math.min(300_000, remaining));
    expect(f.sign).toHaveBeenCalledExactlyOnceWith({
      key: task.object_key,
      expiresAt: new Date(before + Math.min(300_000, remaining)),
    });
    const audit = await f.audits();
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'export_download',
        admin_id: f.actor.id,
        at: f.clock.now(),
        after: expect.objectContaining({
          task_id: task.public_id,
          resource: 'users',
          masked: false,
        }),
      }),
    ]);
    expect(text(audit)).not.toContain(data.url);
    expect(text(f.lines)).not.toContain(data.url);
    expect(f.guarded.mock.calls.map(([input]) => input.permission)).toContain('export');
  },
);

it('[AC-B1-34f#17] 每次下载重新签名、重新鉴权及独立审计，无需新的动态码', async () => {
  const f = await setup(h);
  const task = await f.done(3_600_000, false);
  const first = await ok<Download>(await f.download(task.public_id), DOWNLOAD, 'get');
  f.clock.advanceMs(60_000);
  const second = await ok<Download>(await f.download(task.public_id), DOWNLOAD, 'get');
  expect(second.url).not.toBe(first.url);
  expect(new Date(second.url_expires_at).getTime() - new Date(first.url_expires_at).getTime()).toBe(
    60_000,
  );
  expect(f.sign).toHaveBeenCalledTimes(2);
  expect(await f.audits()).toHaveLength(2);
  await f.revoke('pii.reveal_phone');
  await error(await f.download(task.public_id), 20001, { fields: ['id'] }, DOWNLOAD, 'get');
  expect(f.sign).toHaveBeenCalledTimes(2);
  expect(await f.audits()).toHaveLength(2);
});

it.each(['other', 'unknown', 'cross_app', 'user.list', 'pii.reveal_phone'] as const)(
  '[AC-B1-34f#18] 下载防探测 %s，audit.view_all 仍不能越权',
  async (kind) => {
    const f = await setup(h, ['export', 'user.list', 'pii.reveal_phone', 'audit.view_all']);
    const other =
      kind === 'other' || kind === 'cross_app'
        ? await seed(h, kind === 'other' ? f.appId : 'foreign_download')
        : undefined;
    const task = await f.done(
      3_600_000,
      false,
      other === undefined ? {} : { created_by: other.id, app_id: other.appId },
    );
    let id = task.public_id;
    if (kind === 'unknown') id = 'exp_UnknownTaskForNoProbing';
    if (kind === 'user.list' || kind === 'pii.reveal_phone') await f.revoke(kind);
    await error(await f.download(id), 20001, { fields: ['id'] }, DOWNLOAD, 'get');
    expect(f.sign).not.toHaveBeenCalled();
    expect(await f.audits()).toEqual([]);
  },
);

it('[AC-B1-34f#19] 超管也不能下载他人任务；身份检查先于状态错误', async () => {
  const f = await setup(h, [], true);
  const other = await seed(h, f.appId);
  const task = await f.task({ created_by: other.id, status: 'cancelled' });
  await error(await f.download(task.public_id), 20001, { fields: ['id'] }, DOWNLOAD, 'get');
  expect(f.sign).not.toHaveBeenCalled();
});

it.each(['pending', 'running', 'failed', 'expired', 'cancelled'] as const)(
  '[AC-B1-34f#20] 本人任务 %s 不能下载，30417 带实际 status',
  async (status) => {
    const f = await setup(h);
    const task = await f.task({ status });
    await error(await f.download(task.public_id), 30417, { status }, DOWNLOAD, 'get');
    expect(f.sign).not.toHaveBeenCalled();
    expect(await f.audits()).toEqual([]);
  },
);

it.each([0, -1])('[AC-B1-34f#21] done 到期边界 %i ms 即按 expired 返回', async (remaining) => {
  const f = await setup(h);
  const task = await f.done(remaining);
  await error(await f.download(task.public_id), 30417, { status: 'expired' }, DOWNLOAD, 'get');
  expect(f.sign).not.toHaveBeenCalled();
  expect(await f.audits()).toEqual([]);
});

it('[AC-B1-34f#22] 下载缺 export 为 10403，停用账号无法继续下载', async () => {
  const f = await setup(h);
  const task = await f.done();
  await f.revoke('export');
  await error(
    await f.download(task.public_id),
    10403,
    { reason: 'admin_permission_denied' },
    DOWNLOAD,
    'get',
  );
  await h.db
    .updateTable('admin_users')
    .set({ status: 'disabled' })
    .where('id', '=', f.actor.id)
    .execute();
  const response = await f.download(task.public_id);
  expect(response.statusCode).toBe(401);
  expect(response.json()).toMatchObject({ code: 10001 });
  expect(f.sign).not.toHaveBeenCalled();
});

it('[AC-B1-34f#23] 签名失败不得返回链接或记成功下载审计', async () => {
  const f = await setup(h);
  const task = await f.done();
  f.sign.mockRejectedValueOnce(new Error('synthetic store failure'));
  await error(await f.download(task.public_id), 50001, undefined, DOWNLOAD, 'get');
  expect(await f.audits()).toEqual([]);
});
