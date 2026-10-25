// B1-27a · who may submit a correction and what is checked before anything else (contract
// adminCorrectUserRealname: user.realname_fix with a totp step-up; body checks first, 20001 with
// data.fields; an unknown user_id or one of another app is 20001 data.fields=[user_id]). None of
// these reaches the vendor or changes anything, and none of them is a submission the audit records
// (only those that pass the permission, step-up and body checks are).
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  NEW,
  OLD,
  PERMISSION,
  REASON,
  audits,
  body,
  correct,
  member,
  ok,
  rejected,
  setup,
  snapshot,
  user,
  verified,
} from './kit.ts';

const h = useHarness();

it.each([
  { permissions: [] as string[] },
  { permissions: ['user.phone_change', 'pii.reveal_identity', 'user.list'] },
])(
  '[AC-B1-27a#4] 没有 user.realname_fix（$permissions）→ 10403 admin_permission_denied，不调供应商、什么都不写',
  async ({ permissions }) => {
    const s = await setup(h);
    const target = await user(h, s.appId);
    await verified(h, target);
    const admin = await member(s, permissions);
    const before = { data: await snapshot(h, s.appId), audits: await audits(h, s.appId) };
    const response = await correct(s, target.id, body(), { as: admin });
    await rejected(response, 10403, { reason: 'admin_permission_denied' });
    expect(s.vendor).not.toHaveBeenCalled();
    expect(await snapshot(h, s.appId)).toEqual(before.data);
    expect(await audits(h, s.appId)).toEqual(before.audits);
  },
);

it('[AC-B1-27a#5] 只持 user.realname_fix 的非超管可以更正', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  const admin = await member(s, [PERMISSION]);
  const data = await ok(await correct(s, target.id, body(), { as: admin }));
  expect(data.user_id).toBe(target.id);
  expect(s.vendor).toHaveBeenCalledTimes(1);
});

it.each([true, false])(
  '[AC-B1-27a#6] 超管=%s 也要有效 totp 令牌：缺失或无效为 10003 tier=totp，不调供应商、什么都不写',
  async (isSuper) => {
    const s = await setup(h);
    const target = await user(h, s.appId);
    await verified(h, target);
    const admin = isSuper ? undefined : await member(s, [PERMISSION]);
    const before = { data: await snapshot(h, s.appId), audits: await audits(h, s.appId) };
    for (const step of [null, 'not-a-step-up-token']) {
      const response = await correct(s, target.id, body(), {
        stepUp: step,
        ...(admin === undefined ? {} : { as: admin }),
      });
      await rejected(response, 10003, { tier: 'totp' });
    }
    expect(s.vendor).not.toHaveBeenCalled();
    expect(await snapshot(h, s.appId)).toEqual(before.data);
    expect(await audits(h, s.appId)).toEqual(before.audits);
  },
);

it.each([
  { case: '缺 name', payload: { id_no: NEW.idNo, reason: REASON }, fields: ['name'] },
  { case: '缺 id_no', payload: { name: NEW.name, reason: REASON }, fields: ['id_no'] },
  { case: '缺 reason', payload: { name: NEW.name, id_no: NEW.idNo }, fields: ['reason'] },
  { case: 'reason 为空', payload: body(NEW, { reason: '' }), fields: ['reason'] },
  {
    case: 'reason 超过 200 字',
    payload: body(NEW, { reason: '核'.repeat(201) }),
    fields: ['reason'],
  },
  { case: 'name 为空', payload: body(NEW, { name: '' }), fields: ['name'] },
  { case: 'name 超过 64 字', payload: body(NEW, { name: '林'.repeat(65) }), fields: ['name'] },
  { case: 'id_no 超过 32 字', payload: body(NEW, { id_no: '4'.repeat(33) }), fields: ['id_no'] },
])(
  '[AC-B1-27a#7] 请求体校验在先（$case）→ 20001 data.fields，不调供应商、不写审计、什么都不改',
  async ({ payload, fields }) => {
    const s = await setup(h);
    const target = await user(h, s.appId);
    await verified(h, target);
    const before = { data: await snapshot(h, s.appId), audits: await audits(h, s.appId) };
    const response = await correct(s, target.id, payload);
    await rejected(response, 20001);
    expect(response.json<{ data: { fields: string[] } }>().data.fields).toEqual(fields);
    expect(s.vendor).not.toHaveBeenCalled();
    expect(await snapshot(h, s.appId)).toEqual(before.data);
    expect(await audits(h, s.appId)).toEqual(before.audits);
  },
);

it('[AC-B1-27a#8] 不存在的 user_id 与别的 App 的用户都是 20001 data.fields=[user_id]，不调供应商、什么都不改', async () => {
  const s = await setup(h);
  const stranger = await user(h, `${s.appId}-other`);
  await verified(h, stranger, OLD);
  const before = {
    data: await snapshot(h, s.appId),
    other: await snapshot(h, stranger.appId),
  };
  for (const id of ['0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01', stranger.id]) {
    const response = await correct(s, id, body());
    await rejected(response, 20001, { fields: ['user_id'] });
  }
  expect(s.vendor).not.toHaveBeenCalled();
  expect(await snapshot(h, s.appId)).toEqual(before.data);
  expect(await snapshot(h, stranger.appId)).toEqual(before.other);
});
