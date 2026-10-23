// B1-27b · the console's phone change (BR-ID-44 细则「保存时的处理」「新手机号已被占用」「改号后全部设备
// 退出登录」; BR-ID-06 正文: the old phone_hmac kept 180 days; contract adminEditUserProfile; task §9:
// 44001 before 30411, no risk_hits for a console refusal). The save takes effect at once and the
// new number is not verified.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seed } from '../../admin/accounts/kit.ts';
import { signedIn, useHarness } from '../../admin/auth/kit.ts';
import {
  REASON,
  RETENTION_MS,
  blocked,
  decrypted,
  detail,
  devices,
  edit,
  hmacOf,
  identities,
  masked,
  noPlaintext,
  ok,
  pushTokensOf,
  refresh,
  rejected,
  row,
  sessionsOf,
  setup,
  snapshot,
  stepUp,
  testPhone,
  user,
} from './kit.ts';

const h = useHarness();

const FULL_WIDTH = (digits: string) =>
  [...digits].map((d) => String.fromCodePoint(0xff10 + Number(d))).join('');

const spaced = (p: string) => `+86 ${p.slice(0, 3)} ${p.slice(3, 7)} ${p.slice(7)}`;

it.each([
  { spelling: 'plain', typed: (p: string) => p },
  { spelling: '+86 spaced', typed: spaced },
  { spelling: '0086 hyphens', typed: (p: string) => `0086-${p.slice(0, 3)}-${p.slice(3)}` },
  { spelling: 'full width', typed: (p: string) => `＋８６${FULL_WIDTH(p)}` },
])(
  '[AC-B1-27b#13] 新号码（$spelling）先规范化，再覆盖 phone_cipher / phone_hmac；不验证新号，保存即生效',
  async ({ typed }) => {
    const s = await setup(h);
    const target = await user(h, s.appId);
    const next = testPhone();
    const response = await edit(s, target.id, { phone: typed(next), reason: REASON });
    const data = await ok(response);
    const stored = await row(h, target);
    expect(stored.phone_hmac).toBe(hmacOf(h, next));
    expect(decrypted(h, stored.phone_cipher)).toBe(next);
    expect(data.phone_masked).toBe(masked(next));
    noPlaintext(s, [target.phone, next], response);
  },
);

it('[AC-B1-27b#14] 响应就是保存后 GET /admin/v1/users/{user_id} 给出的用户，号码脱敏 3+4', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const next = testPhone();
  const response = await edit(s, target.id, { phone: next, nickname: '小狸', reason: REASON });
  const data = await ok(response);
  expect(data).toEqual(await detail(s, target.id));
  expect(data).toMatchObject({ user_id: target.id, nickname: '小狸', phone_masked: masked(next) });
  noPlaintext(s, [target.phone, next], response);
});

it('[AC-B1-27b#15] 旧 phone_hmac 写入 deleted_identities（reason=phone_changed，保留 180 天），新号不写', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const next = testPhone();
  const before = await identities(h, s.appId);
  await ok(await edit(s, target.id, { phone: next, reason: REASON }));
  const now = s.clock.now();
  const rows = await identities(h, s.appId);
  expect(before).toEqual([]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    app_id: s.appId,
    reason: 'phone_changed',
    phone_hmac: target.hmac,
    device_hash: null,
    deleted_at: now,
  });
  expect(rows[0]!.expire_at.getTime() - rows[0]!.deleted_at.getTime()).toBe(RETENTION_MS);
  expect(rows.some((entry) => entry.phone_hmac === hmacOf(h, next))).toBe(false);
});

it('[AC-B1-27b#16] 改号成功同一事务作废该用户全部会话与刷新令牌（phone_changed），被退出的设备刷新得 10404', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const other = await user(h, s.appId);
  const mine = await devices(h, s.clock, target, 2);
  const theirs = await devices(h, s.clock, other, 1);
  // A session ended earlier keeps its own time and reason.
  const [earlier] = (await devices(h, s.clock, target, 1)).pairs;
  const endedAt = s.clock.now();
  await h.db
    .updateTable('sessions')
    .set({ revoked_at: endedAt, revoke_reason: 'logout', updated_at: endedAt })
    .where('app_id', '=', s.appId)
    .where('sid', '=', earlier!.sid)
    .execute();
  const othersBefore = await sessionsOf(h, other);
  await ok(await edit(s, target.id, { phone: testPhone(), reason: REASON }));
  const now = s.clock.now();
  const rows = await sessionsOf(h, target);
  expect(rows).toHaveLength(3);
  for (const entry of rows) {
    const expected =
      entry.sid === earlier!.sid
        ? { revoked_at: endedAt, revoke_reason: 'logout' }
        : { revoked_at: now, revoke_reason: 'phone_changed' };
    expect(entry, entry.sid).toMatchObject(expected);
  }
  for (const pair of mine.pairs) {
    expect(await refresh(s, mine, pair, s.appId)).toEqual({ code: 10404 });
  }
  // Another user of the app keeps every session.
  expect(await sessionsOf(h, other)).toEqual(othersBefore);
  expect((await refresh(s, theirs, theirs.pairs[0]!, s.appId)).code).toBe(0);
});

it('[AC-B1-27b#17] 被作废会话的推送令牌按 BR-ID-07 解绑，其他用户的不动', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const other = await user(h, s.appId);
  const mine = await devices(h, s.clock, target, 2);
  const theirs = await devices(h, s.clock, other, 1);
  const before = await pushTokensOf(h, s.appId);
  await ok(await edit(s, target.id, { phone: testPhone(), reason: REASON }));
  const after = await pushTokensOf(h, s.appId);
  for (const pair of mine.pairs) {
    expect(after.find((entry) => entry.id === pair.pushId)).toMatchObject({
      user_id: null,
      bound_sid: null,
    });
  }
  const untouched = theirs.pairs[0]!.pushId;
  expect(after.find((entry) => entry.id === untouched)).toEqual(
    before.find((entry) => entry.id === untouched),
  );
});

it.each(['', '12345', '+1 202 555 0123', '1290000123', `2${testPhone().slice(1)}`])(
  '[AC-B1-27b#18] 规范化不通过（%j）→ 20001 [phone] phone_invalid，什么都不写',
  async (phone) => {
    const s = await setup(h);
    const target = await user(h, s.appId);
    await devices(h, s.clock, target, 1);
    const before = await snapshot(h, s.appId);
    const response = await edit(s, target.id, { phone, nickname: '小狸', reason: REASON });
    await rejected(response, 20001, { fields: ['phone'], reason: 'phone_invalid' });
    expect(await snapshot(h, s.appId)).toEqual(before);
  },
);

it('[AC-B1-27b#19] 新号命中黑名单 → 44001，不保存、不作废会话、不写审计，也不记 risk_hits', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await devices(h, s.clock, target, 2);
  const next = testPhone();
  await blocked(h, s.clock, s.appId, next);
  const before = await snapshot(h, s.appId);
  const response = await edit(s, target.id, { phone: next, nickname: '小狸', reason: REASON });
  await rejected(response, 44001);
  const after = await snapshot(h, s.appId);
  expect(after).toEqual(before);
  expect(after.riskHits).toEqual([]);
  noPlaintext(s, [target.phone, next], response);
});

it('[AC-B1-27b#20] 新号既命中黑名单又已被占用时先报 44001', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const holder = await user(h, s.appId);
  await blocked(h, s.clock, s.appId, holder.phone!);
  const before = await snapshot(h, s.appId);
  await rejected(await edit(s, target.id, { phone: holder.phone, reason: REASON }), 44001);
  expect(await snapshot(h, s.appId)).toEqual(before);
});

it.each(['normal', 'deleting'] as const)(
  '[AC-B1-27b#21] 新号属于本 App 另一账号（status=%s，冷静期账号 status 仍为 normal）→ 30411 不带 reason，不并号、不写',
  async (status) => {
    const s = await setup(h);
    const target = await user(h, s.appId);
    const holder = await user(h, s.appId, { status });
    await devices(h, s.clock, target, 1);
    const before = await snapshot(h, s.appId);
    // Another spelling of the holder's number: the occupancy is judged after normalisation.
    const typed = `+86 ${holder.phone!}`;
    const response = await edit(s, target.id, { phone: typed, reason: REASON });
    await rejected(response, 30411);
    expect(response.json().data?.['reason']).toBeUndefined();
    expect(response.json().data?.['merge_ticket']).toBeUndefined();
    expect(await snapshot(h, s.appId)).toEqual(before);
    noPlaintext(s, [target.phone, holder.phone], response);
  },
);

it('[AC-B1-27b#22] 已完成注销账号的号码、别的 App 账号的号码都可以用', async () => {
  const s = await setup(h);
  const first = await user(h, s.appId);
  const gone = await user(h, s.appId, { status: 'deleted' });
  await ok(await edit(s, first.id, { phone: gone.phone, reason: REASON }));
  expect((await row(h, first)).phone_hmac).toBe(gone.hmac);
  const second = await user(h, s.appId);
  const foreign = await user(h, `foreign-${randomUUID()}`);
  await ok(await edit(s, second.id, { phone: foreign.phone, reason: REASON }));
  expect((await row(h, second)).phone_hmac).toBe(foreign.hmac);
});

it('[AC-B1-27b#23] 新号规范化后与现号相同即视为未改：即便现号在黑名单上也不检查，不写、不作废会话，只记一条审计', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const mine = await devices(h, s.clock, target, 2);
  await blocked(h, s.clock, s.appId, target.phone!);
  const before = await snapshot(h, s.appId);
  const data = await ok(await edit(s, target.id, { phone: spaced(target.phone!), reason: REASON }));
  expect(data.phone_masked).toBe(masked(target.phone!));
  const after = await snapshot(h, s.appId);
  expect({ ...after, audits: [] }).toEqual({ ...before, audits: [] });
  expect(after.audits).toHaveLength(before.audits.length + 1);
  for (const pair of mine.pairs) expect((await refresh(s, mine, pair, s.appId)).code).toBe(0);
});

it('[AC-B1-27b#24] 已生效的保存再提交一次：同样的用户、只多一条审计，不再写 deleted_identities 或作废之后的新会话', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const next = testPhone();
  const body = { phone: next, reason: REASON };
  const first = await ok(await edit(s, target.id, body));
  const signedInAgain = await devices(h, s.clock, target, 1);
  const before = await snapshot(h, s.appId);
  const second = await ok(await edit(s, target.id, body));
  expect(second).toEqual(first);
  const after = await snapshot(h, s.appId);
  expect({ ...after, audits: [] }).toEqual({ ...before, audits: [] });
  expect(after.audits).toHaveLength(before.audits.length + 1);
  expect(after.identities).toHaveLength(1);
  expect((await refresh(s, signedInAgain, signedInAgain.pairs[0]!, s.appId)).code).toBe(0);
});

it('[AC-B1-27b#25] 两个管理员同时把两个用户改成同一个新号：恰好一个成功，另一个 30411，库里只一人持有', async () => {
  const s = await setup(h);
  const left = await user(h, s.appId);
  const right = await user(h, s.appId);
  const second = await seed(h, s.appId, { isSuper: true });
  const secondSession = await signedIn(s, second);
  const admin = { who: second, token: secondSession.admin_token };
  const next = testPhone();
  const tokens = [await stepUp(s), await stepUp(s, second, admin.token)];
  const responses = await Promise.all([
    edit(s, left.id, { phone: next, reason: REASON }, { stepUp: tokens[0]! }),
    edit(s, right.id, { phone: next, reason: REASON }, { as: admin, stepUp: tokens[1]! }),
  ]);
  expect(responses.map((r) => r.json().code).sort((a, b) => a - b)).toEqual([0, 30411]);
  for (const response of responses) {
    if (response.json().code === 0) await ok(response);
    else await rejected(response, 30411);
  }
  const holders = await h.db
    .selectFrom('users')
    .select('id')
    .where('app_id', '=', s.appId)
    .where('phone_hmac', '=', hmacOf(h, next))
    .execute();
  expect(holders).toHaveLength(1);
  expect(await identities(h, s.appId)).toHaveLength(1);
});
