import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  alive,
  error,
  expectAccount,
  harness,
  ok,
  setup,
  signInAgain,
  text,
  type Account,
} from './kit.ts';

// adminUpdateAdminDisplayName (contract CT-24o; task §9: renaming voids no session). Before the
// implementation the route is not registered: every request fails its first status assertion.
const h = harness(createTestDatabase, acquireTestRedis);

it('[AC-B1-34h#24] 改显示名不需 step-up：去首尾空白，列表与详情显示新名，账号名不变，写审计，会话不作废', async () => {
  const f = await setup(h);
  const a = await f.target();
  await h.db
    .updateTable('admin_users')
    .set({ display_name: '旧显示名' })
    .where('id', '=', a.id)
    .execute();
  const own = await signInAgain(f, a);
  const before = await f.row(a.id);
  const result = await ok<Account>(
    await f.send('rename', { token: f.token, id: a.id, body: { display_name: '  财务小狸  ' } }),
    'rename',
  );
  expectAccount(result, {
    ...a.expected,
    display_name: '财务小狸',
    row_version: before.row_version + 1,
  });
  expect(await f.row(a.id)).toEqual({
    ...before,
    display_name: '财务小狸',
    row_version: before.row_version + 1,
    updated_at: expect.anything(),
  });
  expect(await f.detail(a.id)).toMatchObject({ username: a.username, display_name: '财务小狸' });
  expect((await f.page()).items.find((item) => item.admin_id === a.id)).toMatchObject({
    username: a.username,
    display_name: '财务小狸',
  });
  await alive(f, own.admin_token);

  const audit = await f.audits('admin_display_name_update');
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ app_id: f.appId, admin_id: f.actor.id });
  expect(text(audit[0])).toContain(a.id);
  expect(text(audit[0]!.before)).toContain('旧显示名');
  expect(text(audit[0]!.after)).toContain('财务小狸');
});

it('[AC-B1-34h#25] 停用的账号也可以改显示名', async () => {
  const f = await setup(h);
  const a = await f.target({ status: 'disabled' });
  const result = await ok<Account>(
    await f.send('rename', { token: f.token, id: a.id, body: { display_name: '运营临时号' } }),
    'rename',
  );
  expect(result).toMatchObject({ status: 'disabled', display_name: '运营临时号' });
  expect(await f.row(a.id)).toMatchObject({ status: 'disabled', display_name: '运营临时号' });
});

it.each([
  ['缺失', {}],
  ['为空', { display_name: '' }],
  ['去空白后为空', { display_name: '   ' }],
  ['33 字', { display_name: '名'.repeat(33) }],
] as const)('[AC-B1-34h#25] 显示名%s返回 20001 display_name，什么都不变', async (_label, body) => {
  const f = await setup(h);
  const a = await f.target();
  const before = await f.snapshot();
  await error(await f.send('rename', { token: f.token, id: a.id, body }), 'rename', 20001, {
    fields: ['display_name'],
  });
  expect(await f.snapshot()).toEqual(before);
});

it.each(['另一位超管', '调用者本人'] as const)(
  '[AC-B1-34h#25] 改%s的显示名返回 10403，什么都不变',
  async (kind) => {
    const f = await setup(h);
    const a = kind === '调用者本人' ? f.actor : await f.target({ isSuper: true });
    const before = await f.snapshot();
    await error(
      await f.send('rename', { token: f.token, id: a.id, body: { display_name: '超管改名' } }),
      'rename',
      10403,
      { reason: 'admin_permission_denied' },
    );
    expect(await f.snapshot()).toEqual(before);
  },
);
