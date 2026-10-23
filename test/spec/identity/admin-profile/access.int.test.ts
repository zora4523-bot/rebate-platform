// B1-27b · who may save and what a save must carry (contract adminEditUserProfile; BR-ID-44 细则
// 「编辑范围」: user.phone_change, totp step-up, a required reason): every refusal here writes
// nothing — no user field, session, deleted identity, risk hit or audit row.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  REASON,
  edit,
  masked,
  member,
  noPlaintext,
  ok,
  rejected,
  setup,
  snapshot,
  testPhone,
  user,
  type EditBody,
} from './kit.ts';

const h = useHarness();

it.each([
  { permissions: [] },
  { permissions: ['user.list', 'user.lookup'] },
  { permissions: ['pii.reveal_phone'] },
  { permissions: ['user.realname_fix', 'fund.adjust'] },
])(
  '[AC-B1-27b#4] 没有 user.phone_change（$permissions）→ 10403 admin_permission_denied，什么都不写',
  async ({ permissions }) => {
    const s = await setup(h);
    const target = await user(h, s.appId);
    const admin = await member(s, permissions);
    const before = await snapshot(h, s.appId);
    for (const body of [
      { phone: testPhone(), reason: REASON },
      { nickname: '小狸', reason: REASON },
    ]) {
      const response = await edit(s, target.id, body, { as: admin });
      await rejected(response, 10403, { reason: 'admin_permission_denied' });
      noPlaintext(s, [target.phone], response);
    }
    expect(await snapshot(h, s.appId)).toEqual(before);
  },
);

it('[AC-B1-27b#5] 只持 user.phone_change 的非超管可以改手机号也可以改昵称', async () => {
  const s = await setup(h);
  const admin = await member(s, ['user.phone_change']);
  const first = await user(h, s.appId);
  const next = testPhone();
  const phone = await ok(await edit(s, first.id, { phone: next, reason: REASON }, { as: admin }));
  expect(phone.phone_masked).toBe(masked(next));
  const second = await user(h, s.appId);
  const body = { nickname: '小狸', reason: REASON };
  const nickname = await ok(await edit(s, second.id, body, { as: admin }));
  expect(nickname.nickname).toBe('小狸');
});

it.each([true, false])(
  '[AC-B1-27b#6] 超管=%s 也要有效 totp 令牌：缺失或无效为 10003 tier=totp，什么都不写',
  async (isSuper) => {
    const s = await setup(h);
    const target = await user(h, s.appId);
    const admin = isSuper ? undefined : await member(s, ['user.phone_change']);
    const before = await snapshot(h, s.appId);
    for (const stepUp of [null, 'not-a-valid-step-up-token']) {
      const response = await edit(
        s,
        target.id,
        { phone: testPhone(), nickname: '小狸', reason: REASON },
        { ...(admin === undefined ? {} : { as: admin }), stepUp },
      );
      await rejected(response, 10003, { tier: 'totp' });
    }
    expect(await snapshot(h, s.appId)).toEqual(before);
  },
);

it('[AC-B1-27b#7] 未登录（无 admin_token）为 401 / 10001，什么都不写', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const before = await snapshot(h, s.appId);
  const response = await edit(s, target.id, { nickname: '小狸', reason: REASON }, { token: null });
  await rejected(response, 10001);
  expect(await snapshot(h, s.appId)).toEqual(before);
});

it('[AC-B1-27b#8] 未知 user_id、别的 app 的用户（带不带 X-App-Id）、非 UUID 都是 20001 [user_id]', async () => {
  const s = await setup(h);
  // A real local user stays present: a write that forgets the user_id filter must show.
  const local = await user(h, s.appId);
  const otherApp = `foreign-${randomUUID()}`;
  const foreign = await user(h, otherApp);
  const before = await snapshot(h, s.appId);
  const foreignBefore = await snapshot(h, otherApp);
  const cases: [string, Record<string, string>][] = [
    [randomUUID(), {}],
    [foreign.id, {}],
    [foreign.id, { 'x-app-id': otherApp }],
    ['not-a-uuid', {}],
  ];
  for (const [id, headers] of cases) {
    const response = await edit(
      s,
      id,
      { phone: testPhone(), nickname: '小狸', reason: REASON },
      { headers },
    );
    await rejected(response, 20001, { fields: ['user_id'] });
    noPlaintext(s, [local.phone, foreign.phone], response);
  }
  expect(await snapshot(h, s.appId)).toEqual(before);
  expect(await snapshot(h, otherApp)).toEqual(foreignBefore);
});

it('[AC-B1-27b#9] phone 与 nickname 都没给 → 20001 [phone, nickname]', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const before = await snapshot(h, s.appId);
  await rejected(await edit(s, target.id, { reason: REASON }), 20001, {
    fields: ['phone', 'nickname'],
  });
  expect(await snapshot(h, s.appId)).toEqual(before);
});

it.each<EditBody>([
  { nickname: '小狸' },
  { phone: testPhone() },
  { nickname: '小狸', reason: '' },
  { nickname: '小狸', reason: '核'.repeat(201) },
  { nickname: '小狸', reason: null },
  { nickname: '小狸', reason: 123 },
])('[AC-B1-27b#10] reason 必填且 1–200 字符，非法 %j → 20001 [reason]', async (body) => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const before = await snapshot(h, s.appId);
  await rejected(await edit(s, target.id, body), 20001, { fields: ['reason'] });
  expect(await snapshot(h, s.appId)).toEqual(before);
});

it.each([1, 200])('[AC-B1-27b#11] reason 长度 %i 是合法边界，保存成功', async (length) => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const body = { nickname: '小狸', reason: '核'.repeat(length) };
  const data = await ok(await edit(s, target.id, body));
  expect(data.nickname).toBe('小狸');
});

it.each<EditBody>([
  { nickname: '小狸', reason: REASON, avatar: 'avatar:custom' },
  { nickname: '小狸', reason: REASON, realname: '张三' },
])('[AC-B1-27b#12] 编辑范围只有手机号与昵称：多出的字段 %j → 20001 并点名该字段', async (body) => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const before = await snapshot(h, s.appId);
  const extra = Object.keys(body).find((key) => !['nickname', 'reason'].includes(key))!;
  await rejected(await edit(s, target.id, body), 20001, { fields: [extra] });
  expect(await snapshot(h, s.appId)).toEqual(before);
});
