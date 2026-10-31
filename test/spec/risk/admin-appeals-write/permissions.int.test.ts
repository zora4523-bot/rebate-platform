// B1-03ze: who may write (CT-24r). risk.appeal guards all three writes (a super admin holds every
// point); claim and register need no step-up. Resolve: upholding, revoking an order appeal and
// revoking a blocked_request appeal with cause rule need risk.appeal only; revoking a ban needs
// risk.ban, a freeze risk.freeze, a blocklist block risk.blocklist, each with a totp step-up (10003
// data.tier=totp). Order of checks: risk.appeal → body → appeal_id → state / CAS → extra point →
// step-up. The routes exist on the admin entry only and need an admin session.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixture, useHarness } from '../../admin/auth/kit.ts';
import {
  CONFLICT,
  DENIED,
  EXTRA,
  LIST,
  REASON,
  STEP_UP,
  UNKNOWN,
  allow,
  appealOf,
  appealRow,
  extraFor,
  mountedWrites,
  refused,
  resolution,
  seed,
  setup,
  snapshot,
  type Kind,
} from './kit.ts';

const h = useHarness();

const KINDS = ['banned', 'frozen', 'blocklist', 'rule', 'order', 'register'] as const;

it.each(KINDS)('[AC-B1-03ze#10] 维持 %s 只需 risk.appeal，不需动态码', async (kind) => {
  const s = await setup(h);
  const { row } = await seed(s, kind);
  const d = await appealOf(await s.resolve(row.id, resolution('upheld', row.row_version)));
  expect(d).toMatchObject({ appeal_id: row.id, status: 'upheld', handler_id: s.a.id });
  expect(await appealRow(s, row.id)).toMatchObject({ status: 'upheld', handler_id: s.a.id });
});

it.each(['rule', 'order', 'register'] as const)(
  '[AC-B1-03ze#11] 撤销 %s 只需 risk.appeal，不需动态码；无效的 step-up 头被忽略',
  async (kind) => {
    const s = await setup(h);
    const { row } = await seed(s, kind);
    const d = await appealOf(
      await s.resolve(row.id, resolution('revoked', row.row_version), 'not-a-step-up-token'),
    );
    expect(d).toMatchObject({ appeal_id: row.id, status: 'revoked', revoke_permission: null });
    expect(await appealRow(s, row.id)).toMatchObject({ status: 'revoked' });
  },
);

const GUARDED = ['banned', 'frozen', 'blocklist'] as const satisfies readonly Kind[];

it.each(GUARDED)(
  '[AC-B1-03ze#12] 撤销 %s：另两个附加权限不能替代 → 10403，无改动',
  async (kind) => {
    const needed = extraFor(kind)!;
    const s = await setup(h, { grants: ['risk.appeal', ...EXTRA.filter((p) => p !== needed)] });
    const { row } = await seed(s, kind);
    const before = await snapshot(s);
    const token = await s.issue();
    await refused(
      await s.resolve(row.id, resolution('revoked', row.row_version), token),
      10403,
      DENIED,
    );
    expect(await snapshot(s)).toEqual(before);
  },
);

it.each(GUARDED)(
  '[AC-B1-03ze#13] 撤销 %s：持附加权限但无 / 无效动态码 → 10003 tier=totp，无改动；有效动态码后成功',
  async (kind) => {
    const s = await setup(h, { grants: ['risk.appeal', extraFor(kind)!] });
    const { row } = await seed(s, kind);
    const before = await snapshot(s);
    for (const token of [null, 'not-a-step-up-token']) {
      await refused(
        await s.resolve(row.id, resolution('revoked', row.row_version), token),
        10003,
        STEP_UP,
      );
      expect(await snapshot(s)).toEqual(before);
    }
    const d = await appealOf(
      await s.resolve(row.id, resolution('revoked', row.row_version), await s.issue()),
    );
    expect(d).toMatchObject({
      appeal_id: row.id,
      status: 'revoked',
      revoke_permission: extraFor(kind),
    });
  },
);

it('[AC-B1-03ze#14] 动态码过期（5 分钟后）→ 10003，无改动', async () => {
  const s = await setup(h, { grants: ['risk.appeal', 'risk.ban'] });
  const { row } = await seed(s, 'banned');
  const token = await s.issue();
  s.f.clock.advanceMs(300_001);
  const before = await snapshot(s);
  await refused(
    await s.resolve(row.id, resolution('revoked', row.row_version), token),
    10003,
    STEP_UP,
  );
  expect(await snapshot(s)).toEqual(before);
});

it('[AC-B1-03ze#15] 超管持全部权限点，撤销封禁仍需动态码', async () => {
  const s = await setup(h, { grants: [], isSuper: true });
  const { row } = await seed(s, 'banned');
  const before = await snapshot(s);
  await refused(await s.resolve(row.id, resolution('revoked', row.row_version)), 10003, STEP_UP);
  expect(await snapshot(s)).toEqual(before);
  const d = await appealOf(
    await s.resolve(row.id, resolution('revoked', row.row_version), await s.issue()),
  );
  expect(d.status).toBe('revoked');
});

it('[AC-B1-03ze#16] 没有 risk.appeal（只持风控附加权限）→ 三个写接口都 10403，无改动', async () => {
  const s = await setup(h, { grants: [...EXTRA] });
  const banned = await seed(s, 'banned');
  const target = await seed(s, 'register');
  const before = await snapshot(s);
  await refused(await s.claim(banned.row.id, { expected_row_version: 0 }), 10403, DENIED);
  await refused(
    await s.resolve(banned.row.id, resolution('upheld', 0), await s.issue()),
    10403,
    DENIED,
  );
  await refused(
    await s.resolve(banned.row.id, resolution('revoked', 0), await s.issue()),
    10403,
    DENIED,
  );
  await refused(
    await s.register({
      target_type: 'blocked_request',
      target_id: target.blocked!.id,
      content: '我只是正常注册',
      reason: REASON,
    }),
    10403,
    DENIED,
  );
  expect(await snapshot(s)).toEqual(before);
});

it('[AC-B1-03ze#17] 顺序：risk.appeal 先于说明 / 原因校验与申诉查找', async () => {
  const s = await setup(h, { grants: ['risk.ban'] });
  const { row, user } = await seed(s, 'banned');
  const before = await snapshot(s);
  // Bodies of the right shape whose note / reason is blank after trimming (a use-case check).
  await refused(
    await s.resolve(row.id, resolution('revoked', row.row_version, '   '), await s.issue()),
    10403,
    DENIED,
  );
  await refused(
    await s.resolve(randomUUID(), resolution('upheld', 0), await s.issue()),
    10403,
    DENIED,
  );
  await refused(
    await s.register({
      target_type: 'account',
      target_id: user!.id,
      content: '请核查',
      reason: '   ',
    }),
    10403,
    DENIED,
  );
  expect(await snapshot(s)).toEqual(before);
});

it('[AC-B1-03ze#18] 顺序：未知申诉 20001 与状态冲突 20902 先于附加权限与动态码', async () => {
  const s = await setup(h);
  const { row } = await seed(s, 'banned');
  const closed = await seed(s, 'frozen', { status: 'upheld' });
  const before = await snapshot(s);
  // No risk.ban / risk.freeze and no step-up token on any of these.
  await refused(await s.resolve(randomUUID(), resolution('revoked', 0)), 20001, UNKNOWN);
  await refused(
    await s.resolve(row.id, resolution('revoked', row.row_version + 1)),
    20902,
    CONFLICT,
  );
  await refused(
    await s.resolve(closed.row.id, resolution('revoked', closed.row.row_version)),
    20902,
    CONFLICT,
  );
  // Body checks come before the appeal lookup.
  await refused(await s.resolve(randomUUID(), resolution('revoked', 0, '   ')), 20001, {
    fields: ['note'],
  });
  // Then, with the CAS satisfied, the extra point and only after it the step-up.
  await refused(await s.resolve(row.id, resolution('revoked', row.row_version)), 10403, DENIED);
  await allow(s, ['risk.ban']);
  await refused(await s.resolve(row.id, resolution('revoked', row.row_version)), 10003, STEP_UP);
  expect(await snapshot(s)).toEqual(before);
});

it('[AC-B1-03ze#19] 撤销 risk.appeal 后下一次写立即 10403', async () => {
  const s = await setup(h);
  const first = await seed(s, 'order');
  const second = await seed(s, 'order');
  await appealOf(await s.claim(first.row.id, { expected_row_version: 0 }));
  await h.db
    .deleteFrom('admin_permissions')
    .where('app_id', '=', s.appId)
    .where('admin_id', '=', s.a.id)
    .execute();
  const before = await snapshot(s);
  await refused(await s.claim(second.row.id, { expected_row_version: 0 }), 10403, DENIED);
  await refused(await s.resolve(first.row.id, resolution('upheld', 1)), 10403, DENIED);
  expect(await snapshot(s)).toEqual(before);
});

it('[AC-B1-03ze#20] 伪造身份头不能越权或换应用', async () => {
  const s = await setup(h, { grants: [] });
  const other = await setup(h);
  const { row } = await seed(other, 'order');
  const before = await snapshot(other);
  const forged = {
    'x-is-super': 'true',
    'x-admin-id': other.a.id,
    'x-app-id': other.appId,
    'x-permissions': 'risk.appeal,risk.ban,risk.freeze,risk.blocklist',
  };
  await refused(await s.claim(row.id, { expected_row_version: 0 }, forged), 10403, DENIED);
  await refused(await s.resolve(row.id, resolution('upheld', 0), null, forged), 10403, DENIED);
  expect(await snapshot(other)).toEqual(before);
});

it('[AC-B1-03ze#21] 三个写接口都必须登录后台', async () => {
  const s = await setup(h);
  const { row } = await seed(s, 'order');
  const before = await snapshot(s);
  const requests = [
    [LIST, { target_type: 'account', target_id: randomUUID(), content: 'x', reason: REASON }],
    [`${LIST}/${row.id}/claim`, { expected_row_version: 0 }],
    [`${LIST}/${row.id}/resolve`, resolution('upheld', 0)],
  ] as const;
  for (const [url, body] of requests) {
    const variants: Record<string, string>[] = [{}, { authorization: 'Bearer forged' }];
    for (const headers of variants) {
      await refused(
        await s.f.app.inject({
          method: 'POST',
          url,
          headers: { 'content-type': 'application/json', ...headers },
          payload: JSON.stringify(body),
        }),
        10001,
      );
    }
  }
  expect(await snapshot(s)).toEqual(before);
});

it('[AC-B1-03ze#22] 三个写接口只在 admin 入口注册', async () => {
  const s = await setup(h);
  expect(mountedWrites(s.f)).toEqual([true, true, true]);
  for (const entry of ['api', 'stream'] as const) {
    expect(mountedWrites(await fixture(h, { entry })), entry).toEqual([false, false, false]);
  }
});
