import { randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { admin_permission } from '../../../../packages/contracts-ts/src/index.ts';
import { grant, seed } from '../accounts/kit.ts';
import { harness, refused, saved, setup, signInAgain, type Setup } from './kit.ts';

// Who may save, with which step-up and body (contract CT-24o adminSaveAdminPermissions: x-auth
// super, totp tier, 20001 [permissions] for a key outside admin_permission or given twice, 20902
// admin_account on a stale expected_row_version; task §9: is_super target and the caller itself
// 10403). Every refusal leaves the app's rows as they were. Before the implementation the route is
// not registered: every request fails its first status assertion.
const h = harness(createTestDatabase, acquireTestRedis);

const versionOf = async (f: Setup, id: string) => (await f.row(id)).row_version;

it('[AC-B1-34k#9] 普通账号即使勾选全部权限点并持有效 step-up 令牌，保存也返回 10403，什么都不变', async () => {
  const f = await setup(h);
  const ordinary = await f.target();
  await grant(h, ordinary, f.actor, [...admin_permission]);
  const session = await signInAgain(f, ordinary);
  const step = await f.issue(ordinary, session.admin_token);
  const victim = await f.target();
  await grant(h, victim, f.actor, ['order.view']);
  const before = await f.snapshot();
  await refused(
    await f.save({
      token: session.admin_token,
      id: victim.id,
      step,
      body: {
        permissions: ['user.lookup'],
        expected_row_version: await versionOf(f, victim.id),
      },
    }),
    10403,
    { reason: 'admin_permission_denied' },
  );
  expect(await f.snapshot()).toEqual(before);
});

it.each(['不带令牌', '令牌无效', '令牌已用过'] as const)(
  '[AC-B1-34k#10] 超管%s保存返回 10003 tier=totp，什么都不变',
  async (kind) => {
    const f = await setup(h);
    const a = await f.target();
    await grant(h, a, f.actor, ['order.view']);
    let step: string | undefined;
    if (kind === '令牌无效') step = 'not-a-step-up';
    if (kind === '令牌已用过') {
      step = await f.issue();
      await saved(
        await f.save({
          token: f.token,
          id: a.id,
          step,
          body: { permissions: ['fund.view'], expected_row_version: await versionOf(f, a.id) },
        }),
      );
    }
    const before = await f.snapshot();
    await refused(
      await f.save({
        token: f.token,
        id: a.id,
        ...(step === undefined ? {} : { step }),
        body: { permissions: ['user.lookup'], expected_row_version: await versionOf(f, a.id) },
      }),
      10003,
      { tier: 'totp' },
    );
    expect(await f.snapshot()).toEqual(before);
  },
);

it.each(['另一位超管', '调用者本人'] as const)(
  '[AC-B1-34k#11] 保存%s的权限点返回 10403，不写 admin_permissions，什么都不变',
  async (kind) => {
    const f = await setup(h);
    const a = kind === '调用者本人' ? f.actor : await f.target({ isSuper: true });
    const step = await f.issue();
    const before = await f.snapshot();
    await refused(
      await f.save({
        token: f.token,
        id: a.id,
        step,
        body: { permissions: ['user.lookup'], expected_row_version: await versionOf(f, a.id) },
      }),
      10403,
      { reason: 'admin_permission_denied' },
    );
    expect(await f.snapshot()).toEqual(before);
    expect(await f.grants(a.id)).toEqual([]);
  },
);

it.each(['unknown', 'malformed', 'other-app'] as const)(
  '[AC-B1-34k#12] admin_id 不存在、不合法或属于其他 app（%s）返回 20001 admin_id',
  async (kind) => {
    const f = await setup(h);
    const foreign =
      kind === 'other-app'
        ? await seed(h, `w_${randomUUID().replaceAll('-', '').slice(0, 24)}`)
        : undefined;
    const id = foreign?.id ?? (kind === 'unknown' ? randomUUID() : 'not-a-uuid');
    const foreignBefore = foreign === undefined ? undefined : await f.row(foreign.id);
    const step = await f.issue();
    const before = await f.snapshot();
    await refused(
      await f.save({
        token: f.token,
        id,
        step,
        body: {
          permissions: ['user.lookup'],
          expected_row_version: foreignBefore?.row_version ?? 0,
        },
      }),
      20001,
      { fields: ['admin_id'] },
    );
    expect(await f.snapshot()).toEqual(before);
    if (foreign !== undefined) {
      expect(await f.row(foreign.id)).toEqual(foreignBefore);
      const grants = await h.db
        .selectFrom('admin_permissions')
        .selectAll()
        .where('admin_id', '=', foreign.id)
        .execute();
      expect(grants).toEqual([]);
    }
  },
);

it.each([
  ['未登记的权限点', ['user.lookup', 'fund.unknown_point']],
  ['已退役的键', ['retired.unknown']],
  ['重复的权限点', ['user.lookup', 'fund.view', 'user.lookup']],
] as const)(
  '[AC-B1-34k#13] permissions 含%s返回 20001 permissions，什么都不写',
  async (_label, permissions) => {
    const f = await setup(h);
    const a = await f.target();
    await grant(h, a, f.actor, ['order.view']);
    const step = await f.issue();
    const before = await f.snapshot();
    await refused(
      await f.save({
        token: f.token,
        id: a.id,
        step,
        body: { permissions, expected_row_version: await versionOf(f, a.id) },
      }),
      20001,
      { fields: ['permissions'] },
    );
    expect(await f.snapshot()).toEqual(before);
  },
);

it('[AC-B1-34k#13] permissions 含不合键格式的值返回 20001，什么都不写', async () => {
  const f = await setup(h);
  const a = await f.target();
  const step = await f.issue();
  const before = await f.snapshot();
  await refused(
    await f.save({
      token: f.token,
      id: a.id,
      step,
      body: { permissions: ['Fund.View'], expected_row_version: await versionOf(f, a.id) },
    }),
    20001,
  );
  expect(await f.snapshot()).toEqual(before);
});

const ROW_VERSION = 'expected_row_version';
it.each([
  ['缺 permissions', { expected_row_version: 0 }, 'permissions'],
  ['缺 expected_row_version', { permissions: ['user.lookup'] }, ROW_VERSION],
  ['expected_row_version 为负数', { permissions: [], expected_row_version: -1 }, ROW_VERSION],
  ['expected_row_version 为字符串', { permissions: [], expected_row_version: '0' }, ROW_VERSION],
  ['permissions 不是数组', { permissions: 'user.lookup', expected_row_version: 0 }, 'permissions'],
  ['多出 is_super', { permissions: [], expected_row_version: 0, is_super: true }, 'is_super'],
] as const)(
  '[AC-B1-34k#14] 请求体%s返回 20001 对应字段，什么都不变',
  async (_label, body, field) => {
    const f = await setup(h);
    const a = await f.target();
    await grant(h, a, f.actor, ['order.view']);
    const step = await f.issue();
    const before = await f.snapshot();
    await refused(await f.save({ token: f.token, id: a.id, step, body }), 20001, {
      fields: [field],
    });
    expect(await f.snapshot()).toEqual(before);
  },
);

it.each([
  ['小于当前值', -1],
  ['大于当前值', 1],
] as const)(
  '[AC-B1-34k#15] expected_row_version %s返回 20902 admin_account，什么都不变',
  async (_label, delta) => {
    const f = await setup(h);
    const a = await f.target();
    await grant(h, a, f.actor, ['order.view']);
    // Two earlier changes (renames), so the current row_version is at least 2.
    for (const name of ['改名一', '改名二']) {
      expect((await f.act('rename', a.id, { display_name: name })).statusCode).toBe(200);
    }
    const current = await versionOf(f, a.id);
    const step = await f.issue();
    const before = await f.snapshot();
    await refused(
      await f.save({
        token: f.token,
        id: a.id,
        step,
        body: { permissions: ['user.lookup'], expected_row_version: current + delta },
      }),
      20902,
      { resource: 'admin_account' },
    );
    expect(await f.snapshot()).toEqual(before);
  },
);

it('[AC-B1-34k#15] 详情读出后账号又被改过（改名），用读出的 row_version 保存返回 20902；刷新后保存成功', async () => {
  const f = await setup(h);
  const a = await f.target();
  const shown = await f.detail(a.id);
  expect(shown.row_version).toBe(await versionOf(f, a.id));
  expect((await f.act('rename', a.id, { display_name: '别人改过' })).statusCode).toBe(200);
  const step = await f.issue();
  const before = await f.snapshot();
  await refused(
    await f.save({
      token: f.token,
      id: a.id,
      step,
      body: { permissions: ['user.lookup'], expected_row_version: shown.row_version },
    }),
    20902,
    { resource: 'admin_account' },
  );
  expect(await f.snapshot()).toEqual(before);

  const fresh = await f.detail(a.id);
  const result = await saved(
    await f.put(a.id, { permissions: ['user.lookup'], expected_row_version: fresh.row_version }),
  );
  expect(result).toMatchObject({
    permissions: ['user.lookup'],
    row_version: fresh.row_version! + 1,
  });
});

it('[AC-B1-34k#16] 两位超管用同一 row_version 并发保存：恰好一个成功，另一个 20902，结果只含成功一方的整组与一条审计', async () => {
  const f = await setup(h);
  const a = await f.target();
  await grant(h, a, f.actor, ['order.view']);
  const other = await f.target({ isSuper: true });
  const otherSession = await signInAgain(f, other);
  const otherStep = await f.issue(other, otherSession.admin_token);
  const step = await f.issue();
  const version = await versionOf(f, a.id);
  const bodies = [
    { permissions: ['user.lookup', 'fund.view'], expected_row_version: version },
    { permissions: ['withdraw.review'], expected_row_version: version },
  ] as const;
  const responses = await Promise.all([
    f.save({ token: f.token, id: a.id, step, body: bodies[0] }),
    f.save({ token: otherSession.admin_token, id: a.id, step: otherStep, body: bodies[1] }),
  ]);
  expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  const winner = responses.findIndex((response) => response.statusCode === 200);
  const loser = 1 - winner;
  const result = await saved(responses[winner]!);
  await refused(responses[loser]!, 20902, { resource: 'admin_account' });
  expect([...result.permissions].sort()).toEqual([...bodies[winner]!.permissions].sort());
  expect(await f.permissionKeys(a.id)).toEqual([...bodies[winner]!.permissions].sort());
  expect(await versionOf(f, a.id)).toBe(version + 1);
  const audit = await f.audits('admin_permissions_save');
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ admin_id: winner === 0 ? f.actor.id : other.id });
});
