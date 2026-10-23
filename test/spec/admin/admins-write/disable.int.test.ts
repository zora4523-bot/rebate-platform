import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { grant } from '../accounts/kit.ts';
import { failure, login, totp } from '../auth/kit.ts';
import {
  alive,
  dead,
  error,
  expectAccount,
  failingApp,
  harness,
  ok,
  sender,
  setup,
  signInAgain,
  text,
  ticketGone,
  type Account,
} from './kit.ts';

// adminDisableAdmin (BR-ID-43「停用后台账号」, BR-ID-42; task §9: sessions voided per account,
// export cancellation in the disabling transaction). Before the implementation the route is not
// registered: every request fails its first status assertion.
const h = harness(createTestDatabase, acquireTestRedis);

it('[AC-B1-34h#13] 停用：令牌、登录凭证与登录即时失效，权限点保留，写审计，其他账号的会话不受影响', async () => {
  const f = await setup(h);
  const a = await f.target();
  await grant(h, a, f.actor, ['user.list', 'fund.view']);
  const bystander = await f.target();
  const own = await signInAgain(f, a);
  const other = await signInAgain(f, bystander);
  f.clock.advanceMs(30_000);
  const pending = await login(f, a);
  const step = await f.issue();
  await alive(f, own.admin_token);
  const before = await f.row(a.id);
  const reason = '该账号使用人已调岗，不再需要查询权限';
  const result = await ok<Account>(
    await f.send('disable', { token: f.token, id: a.id, body: { reason }, step }),
    'disable',
  );
  expectAccount(result, {
    ...a.expected,
    status: 'disabled',
    permissions: ['user.list', 'fund.view'],
    row_version: before.row_version + 1,
  });
  expect(await f.row(a.id)).toMatchObject({
    status: 'disabled',
    row_version: before.row_version + 1,
    login_name: a.username,
    password_hash: before.password_hash,
    totp_bound_at: before.totp_bound_at,
  });
  expect(await f.permissionKeys(a.id)).toEqual(['fund.view', 'user.list']);

  await dead(f, own.admin_token);
  f.clock.advanceMs(30_000);
  ticketGone(
    await f.post('/totp', { login_ticket: pending.login_ticket, code: totp(a.secret, f.clock) }),
  );
  await failure(
    await f.post('/login', { username: a.username, password: a.password }),
    '/login',
    10008,
  );
  await alive(f, f.token);
  await alive(f, other.admin_token);

  const audit = await f.audits('admin_account_disable');
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ app_id: f.appId, admin_id: f.actor.id });
  expect(text(audit[0])).toContain(a.id);
  expect(text(audit[0])).toContain(reason);
  expect(text(audit[0]!.before)).toContain('active');
  expect(text(audit[0]!.after)).toContain('disabled');
}, 30_000);

it('[AC-B1-34h#14] 停用时该账号 pending / running 的导出置 cancelled 并各写一条审计，其余任务不变', async () => {
  const f = await setup(h);
  const a = await f.target();
  const other = await f.target();
  const active = [await f.exportTask(a.id, 'pending'), await f.exportTask(a.id, 'running')];
  const untouched: (typeof active)[number][] = [];
  for (const status of ['done', 'failed', 'expired', 'cancelled']) {
    untouched.push(await f.exportTask(a.id, status));
  }
  untouched.push(await f.exportTask(other.id, 'pending'));
  untouched.push(await f.exportTask(f.actor.id, 'running'));
  await ok(await f.act('disable', a.id), 'disable');
  for (const task of active) {
    expect(await f.exportRow(task.id)).toMatchObject({
      status: 'cancelled',
      row_version: task.row_version + 1,
    });
  }
  for (const task of untouched) expect(await f.exportRow(task.id)).toEqual(task);
  const cancels = await f.audits('export_cancel');
  expect(cancels).toHaveLength(active.length);
  for (const task of active) {
    expect(cancels.filter((item) => text(item).includes(task.public_id))).toHaveLength(1);
  }
});

it.each([
  [
    '取消导出时',
    (node: string) => node.includes('"UpdateQueryNode"') && node.includes('"export_tasks"'),
  ],
  [
    '写停用审计时',
    (node: string) => node.includes('"InsertQueryNode"') && node.includes('admin_account_disable'),
  ],
] as const)(
  '[AC-B1-34h#15] 停用在%s失败则整体回滚：账号仍启用、导出未取消、没有审计',
  async (_label, fails) => {
    const f = await setup(h);
    const a = await f.target();
    await f.exportTask(a.id, 'pending');
    await f.exportTask(a.id, 'running');
    const app = await failingApp(h, f, fails);
    const step = await f.issue();
    const before = await f.snapshot();
    await error(
      await sender(app)('disable', {
        token: f.token,
        id: a.id,
        body: { reason: '演示回滚' },
        step,
      }),
      'disable',
      50001,
    );
    expect(await f.snapshot()).toEqual(before);
  },
);

it.each([
  ['disable', '缺失', {}],
  ['disable', '为空', { reason: '' }],
  ['disable', '超过 200 字', { reason: '因'.repeat(201) }],
  ['reset', '缺失', {}],
  ['reset', '为空', { reason: '' }],
  ['reset', '超过 200 字', { reason: '因'.repeat(201) }],
] as const)(
  '[AC-B1-34h#16] %s 的 reason %s 返回 20001 reason，什么都不变',
  async (operation, _label, body) => {
    const f = await setup(h);
    const a = await f.target();
    const step = await f.issue();
    const before = await f.snapshot();
    await error(
      await f.send(operation, { token: f.token, id: a.id, body, step }),
      operation,
      20001,
      { fields: ['reason'] },
    );
    expect(await f.snapshot()).toEqual(before);
  },
);

it.each([
  ['已停用的账号', 'disabled', 20902, { resource: 'admin_account' }],
  ['另一位超管', 'super', 10403, { reason: 'admin_permission_denied' }],
  ['调用者本人', 'self', 10403, { reason: 'admin_permission_denied' }],
] as const)('[AC-B1-34h#17] 停用%s返回对应错误，什么都不变', async (_label, kind, code, data) => {
  const f = await setup(h);
  const a =
    kind === 'self'
      ? f.actor
      : await f.target(kind === 'super' ? { isSuper: true } : { status: 'disabled' });
  const step = await f.issue();
  const before = await f.snapshot();
  await error(
    await f.send('disable', { token: f.token, id: a.id, body: { reason: '演示' }, step }),
    'disable',
    code,
    data,
  );
  expect(await f.snapshot()).toEqual(before);
  await alive(f, f.token);
});
