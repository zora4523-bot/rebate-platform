// B1-27c · checks before anything is judged (contract adminCreateUserDataExport /
// adminListUserDataExports; task §9 ①): the permission point user.data_export (10403
// admin_permission_denied), the totp step-up of the registration (10003 tier totp; the list needs
// none), the body (20001 data.fields) and the user (unknown or another app's: 20001 [user_id]).
// A call stopped here registers nothing, sends no generation job and — for the permission, step-up
// and body checks — writes no user_data_copy_request audit record.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  PERMISSION,
  PII,
  REASON,
  allAudits,
  audits,
  copiesOf,
  inApp,
  jobs,
  list,
  listed,
  member,
  ok,
  register,
  rejected,
  setup,
  user,
  wecom,
} from './kit.ts';

const h = useHarness();

it.each([
  { case: '没有任何权限点', permissions: [] as string[] },
  { case: '只有 pii.reveal_phone', permissions: [PII] },
  { case: '只有 user.list', permissions: ['user.list'] },
])(
  '[AC-B1-27c#4] 登记缺 user.data_export（$case）→ 10403 admin_permission_denied，什么都不写',
  async ({ permissions }) => {
    const s = await setup(h);
    const target = await user(s);
    const caller = await member(s, permissions);
    const before = await allAudits(s);
    for (const payload of [inApp(), wecom()]) {
      await rejected(await register(s, target.id, payload, { as: caller }), 10403, {
        reason: 'admin_permission_denied',
      });
    }
    expect(await copiesOf(s, target)).toEqual([]);
    expect(jobs(s)).toEqual([]);
    expect(await allAudits(s)).toEqual(before);
  },
);

it('[AC-B1-27c#5] 登记要 totp 档二次验证：不带或带无效的 X-Step-Up-Token → 10003 tier=totp，什么都不写', async () => {
  const s = await setup(h);
  const target = await user(s);
  const caller = await member(s, [PERMISSION]);
  for (const step of [null, 'not-a-valid-step-up-token']) {
    await rejected(await register(s, target.id, inApp(), { as: caller, stepUp: step }), 10003, {
      tier: 'totp',
    });
  }
  expect(await copiesOf(s, target)).toEqual([]);
  expect(jobs(s)).toEqual([]);
  expect(await audits(s)).toEqual([]);
  // The same admin with a valid token is accepted (the refusals above were the step-up's).
  const data = await ok(await register(s, target.id, inApp(), { as: caller }));
  expect(data).toMatchObject({ user_id: target.id, reused: false, requested_by: caller.who.id });
});

it.each([
  { case: 'reason 缺失', payload: { app_login_ok: true, phone_sms_ok: true }, field: 'reason' },
  { case: 'reason 为空串', payload: inApp({ reason: '' }), field: 'reason' },
  { case: 'reason 超过 200 字', payload: inApp({ reason: '核'.repeat(201) }), field: 'reason' },
  { case: 'reason 不是字符串', payload: inApp({ reason: 42 }), field: 'reason' },
  {
    case: 'app_login_ok 缺失',
    payload: { reason: REASON, phone_sms_ok: true },
    field: 'app_login_ok',
  },
  {
    case: 'app_login_ok 不是布尔',
    payload: inApp({ app_login_ok: 'true' }),
    field: 'app_login_ok',
  },
  {
    case: 'phone_sms_ok 缺失',
    payload: { reason: REASON, app_login_ok: false },
    field: 'phone_sms_ok',
  },
  { case: 'phone_sms_ok 不是布尔', payload: inApp({ phone_sms_ok: 1 }), field: 'phone_sms_ok' },
])(
  '[AC-B1-27c#6] 请求体校验：$case → 20001 fields=[$field]，什么都不写',
  async ({ payload, field }) => {
    const s = await setup(h);
    const target = await user(s);
    await rejected(await register(s, target.id, payload), 20001, { fields: [field] });
    expect(await copiesOf(s, target)).toEqual([]);
    expect(jobs(s)).toEqual([]);
    expect(await audits(s)).toEqual([]);
  },
);

it('[AC-B1-27c#7] reason 恰好 200 字照常受理', async () => {
  const s = await setup(h);
  const target = await user(s);
  const reason = '核'.repeat(200);
  const data = await ok(await register(s, target.id, inApp({ reason })));
  expect(data).toMatchObject({ user_id: target.id, delivery: 'in_app_sms', reused: false });
  expect(await copiesOf(s, target)).toHaveLength(1);
});

it('[AC-B1-27c#8] 未知 user_id 与别的 app 的用户：登记 → 20001 fields=[user_id]，不建请求、不入队', async () => {
  const s = await setup(h);
  const foreign = await user(s, { appId: `rg_${'f'.repeat(8)}${s.appId.slice(-8)}` });
  for (const id of ['0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c99', foreign.id]) {
    await rejected(await register(s, id, inApp()), 20001, { fields: ['user_id'] });
  }
  expect(await copiesOf(s, foreign)).toEqual([]);
  expect(
    await s.h.db
      .selectFrom('personal_data_copies')
      .select('id')
      .where('app_id', '=', s.appId)
      .execute(),
  ).toEqual([]);
  expect(jobs(s)).toEqual([]);
});

it('[AC-B1-27c#9] 列表要 user.data_export：缺 → 10403；只持 user.data_export 不带二次验证即可读', async () => {
  const s = await setup(h);
  const target = await user(s);
  for (const permissions of [[], [PII], ['user.list']]) {
    const caller = await member(s, permissions);
    await rejected(
      await list(s, target.id, '', { as: caller }),
      10403,
      { reason: 'admin_permission_denied' },
      'get',
    );
  }
  const reader = await member(s, [PERMISSION]);
  const page = await listed(await list(s, target.id, '', { as: reader }));
  expect(page).toEqual({ items: [], page: 1, page_size: 20, total: 0 });
});

it('[AC-B1-27c#10] 列表：未知 user_id 与别的 app 的用户 → 20001 fields=[user_id]；page_size 超过 200 → 20001 fields=[page_size]', async () => {
  const s = await setup(h);
  const target = await user(s);
  const foreign = await user(s, { appId: `rg_${'e'.repeat(8)}${s.appId.slice(-8)}` });
  for (const id of ['0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c98', foreign.id]) {
    await rejected(await list(s, id), 20001, { fields: ['user_id'] }, 'get');
  }
  await rejected(
    await list(s, target.id, '?page_size=201'),
    20001,
    { fields: ['page_size'] },
    'get',
  );
  const page = await listed(await list(s, target.id, '?page_size=200'));
  expect(page).toMatchObject({ items: [], page: 1, page_size: 200, total: 0 });
});
