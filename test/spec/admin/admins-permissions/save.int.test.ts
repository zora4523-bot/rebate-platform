import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { grant } from '../accounts/kit.ts';
import { error as exportError, LIST, ok as exportOk, type Page } from '../exports/kit.ts';
import { ME, ok as stepOk, type Me } from '../step-up/kit.ts';
import {
  alive,
  expectAccount,
  failingApp,
  harness,
  refused,
  saved,
  saver,
  setup,
  signInAgain,
  text,
} from './kit.ts';

// adminSaveAdminPermissions (contract CT-24o; 08 BR-ID-34「勾选与撤销只限超管、需 step-up 并写审计」;
// task §9: one transaction, CAS on admin_users.row_version, the set difference deleted and inserted,
// sessions keep running on the new points). Before the implementation the route is not registered
// and the reads carry no row_version: every case fails an assertion.
const h = harness(createTestDatabase, acquireTestRedis);

it('[AC-B1-34k#2] 详情与列表输出 row_version，原样作为 expected_row_version 保存即成功：整组替换、row_version 加一', async () => {
  const f = await setup(h);
  const a = await f.target();
  await grant(h, a, f.actor, ['user.lookup', 'order.view']);
  const before = await f.row(a.id);
  const shown = await f.detail(a.id);
  expect(shown.row_version).toBe(before.row_version);
  const listed = (await f.page()).items.find((item) => item.admin_id === a.id);
  expect(listed?.row_version).toBe(before.row_version);

  const wanted = ['user.lookup', 'fund.view', 'fund.adjust'];
  const result = await saved(
    await f.put(a.id, { permissions: wanted, expected_row_version: shown.row_version }),
  );
  expectAccount(result, {
    ...a.expected,
    permissions: wanted,
    row_version: before.row_version + 1,
  });
  expect(await f.row(a.id)).toEqual({
    ...before,
    row_version: before.row_version + 1,
    updated_at: expect.anything(),
  });
  expect(await f.permissionKeys(a.id)).toEqual([...wanted].sort());
  const after = await f.detail(a.id);
  expect([...after.permissions].sort()).toEqual([...wanted].sort());
  expect(after.row_version).toBe(before.row_version + 1);
  const relisted = (await f.page()).items.find((item) => item.admin_id === a.id);
  expect(relisted?.row_version).toBe(before.row_version + 1);
});

it('[AC-B1-34k#3] 只删增差集：保留的权限点行原样不动，新增行记操作超管与注入时钟的时间，撤销的行删除，其他账号不受影响', async () => {
  const f = await setup(h);
  const a = await f.target();
  const bystander = await f.target();
  await grant(h, a, f.actor, ['user.lookup', 'order.view', 'withdraw.review']);
  await grant(h, bystander, f.actor, ['user.lookup', 'order.view']);
  const rows = await f.grants(a.id);
  const kept = rows.filter((row) => row.permission_key !== 'order.view');
  const others = await f.grants(bystander.id);
  const bystanderRow = await f.row(bystander.id);
  const step = await f.issue();
  const at = f.clock.now();

  await saved(
    await f.save({
      token: f.token,
      id: a.id,
      step,
      body: {
        permissions: ['withdraw.review', 'user.lookup', 'fund.view'],
        expected_row_version: (await f.row(a.id)).row_version,
      },
    }),
  );
  const now = await f.grants(a.id);
  expect(now.map((row) => row.permission_key)).toEqual([
    'fund.view',
    'user.lookup',
    'withdraw.review',
  ]);
  for (const row of kept) {
    expect(now.find((item) => item.permission_key === row.permission_key)).toEqual(row);
  }
  expect(now.find((item) => item.permission_key === 'fund.view')).toMatchObject({
    app_id: f.appId,
    admin_id: a.id,
    granted_by: f.actor.id,
    granted_at: at,
  });
  expect(await f.grants(bystander.id)).toEqual(others);
  expect(await f.row(bystander.id)).toEqual(bystanderRow);
});

it('[AC-B1-34k#4] 空数组撤销全部权限点，响应与详情的 permissions 为空', async () => {
  const f = await setup(h);
  const a = await f.target();
  await grant(h, a, f.actor, ['user.list', 'export', 'fund.view']);
  const version = (await f.row(a.id)).row_version;
  const result = await saved(await f.put(a.id, { permissions: [], expected_row_version: version }));
  expect(result).toMatchObject({ admin_id: a.id, permissions: [], row_version: version + 1 });
  expect(await f.permissionKeys(a.id)).toEqual([]);
  expect((await f.detail(a.id)).permissions).toEqual([]);
});

it('[AC-B1-34k#5] 保存写一条 admin_permissions_save 审计：操作人为超管，记目标账号与保存前后的权限点', async () => {
  const f = await setup(h);
  const a = await f.target();
  await grant(h, a, f.actor, ['user.lookup', 'order.view']);
  const step = await f.issue();
  const others = await f.audits();
  await saved(
    await f.save({
      token: f.token,
      id: a.id,
      step,
      body: {
        permissions: ['user.lookup', 'fund.view', 'fund.adjust'],
        expected_row_version: (await f.row(a.id)).row_version,
      },
    }),
  );
  const audit = await f.audits('admin_permissions_save');
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ app_id: f.appId, admin_id: f.actor.id });
  expect(text(audit[0])).toContain(a.id);
  const before = text(audit[0]!.before);
  for (const key of ['user.lookup', 'order.view']) expect(before).toContain(key);
  const after = text(audit[0]!.after);
  for (const key of ['user.lookup', 'fund.view', 'fund.adjust']) expect(after).toContain(key);
  // The save adds no audit record besides its own.
  expect((await f.audits()).filter((row) => !others.some((old) => old.id === row.id))).toEqual(
    audit,
  );
});

it('[AC-B1-34k#6] 停用的账号也可以保存，状态仍为停用；启用后得到保存的权限点', async () => {
  const f = await setup(h);
  const a = await f.target({ status: 'disabled' });
  await grant(h, a, f.actor, ['order.view']);
  const result = await saved(
    await f.put(a.id, {
      permissions: ['user.lookup', 'fund.view'],
      expected_row_version: (await f.row(a.id)).row_version,
    }),
  );
  expect(result).toMatchObject({ status: 'disabled' });
  expect(await f.row(a.id)).toMatchObject({ status: 'disabled' });
  expect(await f.permissionKeys(a.id)).toEqual(['fund.view', 'user.lookup']);
  const enabled = await f.act('enable', a.id);
  expect(enabled.statusCode).toBe(200);
  expect([...(await f.detail(a.id)).permissions].sort()).toEqual(['fund.view', 'user.lookup']);
});

it('[AC-B1-34k#7] 目标账号已签发的会话不吊销，下一次请求即按新权限点：撤销后 10403，再勾选后恢复', async () => {
  const f = await setup(h);
  const a = await f.target();
  await grant(h, a, f.actor, ['export', 'user.lookup']);
  const own = await signInAgain(f, a);
  await exportOk<Page>(await f.read(own.admin_token, LIST), LIST, 'get');

  await saved(
    await f.put(a.id, {
      permissions: ['user.lookup', 'fund.view'],
      expected_row_version: (await f.row(a.id)).row_version,
    }),
  );
  await alive(f, own.admin_token);
  const me = await stepOk<Me>(await f.read(own.admin_token, ME), ME);
  expect(me.permissions.map((item) => item.key).sort()).toEqual(['fund.view', 'user.lookup']);
  await exportError(
    await f.read(own.admin_token, LIST),
    10403,
    { reason: 'admin_permission_denied' },
    LIST,
    'get',
  );

  await saved(
    await f.put(a.id, {
      permissions: ['export'],
      expected_row_version: (await f.row(a.id)).row_version,
    }),
  );
  await exportOk<Page>(await f.read(own.admin_token, LIST), LIST, 'get');
  const again = await stepOk<Me>(await f.read(own.admin_token, ME), ME);
  expect(again.permissions.map((item) => item.key)).toEqual(['export']);
});

it('[AC-B1-34k#8] 写审计失败则整体回滚：权限点、row_version 与审计都不变', async () => {
  const f = await setup(h);
  const a = await f.target();
  await grant(h, a, f.actor, ['user.lookup', 'order.view']);
  const app = await failingApp(
    h,
    f,
    (node) => node.includes('"InsertQueryNode"') && node.includes('admin_permissions_save'),
  );
  const step = await f.issue();
  const before = await f.snapshot();
  await refused(
    await saver(app)({
      token: f.token,
      id: a.id,
      step,
      body: {
        permissions: ['fund.view'],
        expected_row_version: (await f.row(a.id)).row_version,
      },
    }),
    50001,
  );
  expect(await f.snapshot()).toEqual(before);
});
