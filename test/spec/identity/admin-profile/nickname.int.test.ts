// B1-27b · the console's nickname change (BR-ID-39 细则「后台改昵称」: length and content-safety
// review as for the user, a hit or a timed-out review refuses the save; not counted in the user's
// 3 changes per month and not using up the user's remaining ones; BR-ID-44 细则: only a phone
// change ends the sessions). The fixture clock (admin auth kit NOW) is in the +08:00 month 2026-10.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  REASON,
  SEED_WORD,
  detail,
  devices,
  edit,
  hmacOf,
  masked,
  ok,
  refresh,
  rejected,
  row,
  sessionsOf,
  setup,
  snapshot,
  testPhone,
  user,
} from './kit.ts';

const h = useHarness();
const MONTH = '2026-10';

it('[AC-B1-27b#26] 改昵称：去首尾空白后保存即生效；不动手机号、不作废会话、不写 deleted_identities', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const mine = await devices(h, s.clock, target, 2);
  const before = await snapshot(h, s.appId);
  const body = { nickname: ' 　小狸\t ', reason: REASON };
  const data = await ok(await edit(s, target.id, body));
  expect(data).toMatchObject({ nickname: '小狸', phone_masked: masked(target.phone!) });
  expect(data).toEqual(await detail(s, target.id));
  const stored = await row(h, target);
  expect(stored).toMatchObject({ nickname: '小狸', phone_hmac: target.hmac });
  expect(stored.phone_cipher).toEqual(target.cipher);
  const after = await snapshot(h, s.appId);
  expect(after.sessions).toEqual(before.sessions);
  expect(after.refreshTokens).toEqual(before.refreshTokens);
  expect(after.pushTokens).toEqual(before.pushTokens);
  expect(after.identities).toEqual([]);
  for (const pair of mine.pairs) expect((await refresh(s, mine, pair, s.appId)).code).toBe(0);
});

it.each([
  { month: MONTH, count: 3 },
  { month: MONTH, count: 1 },
  { month: '2026-09', count: 3 },
  { month: null, count: 0 },
])(
  '[AC-B1-27b#27] 后台改昵称不计入用户每月 3 次、也不占用余下次数（$month 已用 $count 次）',
  async ({ month, count }) => {
    const s = await setup(h);
    const target = await user(h, s.appId, { month, count });
    await ok(await edit(s, target.id, { nickname: '小狸', reason: REASON }));
    expect(await row(h, target)).toMatchObject({
      nickname: '小狸',
      nickname_change_month: month,
      nickname_change_count: count,
    });
  },
);

// One extended grapheme cluster each: a ZWJ family emoji (5 code points), e + combining acute.
const FAMILY = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
const ACUTE_E = 'é';

it.each([
  {
    label: '16 个字素（含 ZWJ 表情与组合字符）',
    nickname: `${FAMILY}${ACUTE_E}${'狸'.repeat(14)}`,
  },
  { label: '1 个字素', nickname: '狸' },
])('[AC-B1-27b#28] 昵称长度按扩展字素簇计：$label 可以保存', async ({ nickname }) => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const body = { nickname: `  ${nickname}  `, reason: REASON };
  const data = await ok(await edit(s, target.id, body));
  expect(data.nickname).toBe(nickname);
  expect((await row(h, target)).nickname).toBe(nickname);
});

it.each(['', '   ', '　\t', '狸'.repeat(17), `${FAMILY.repeat(16)}狸`])(
  '[AC-B1-27b#29] 去首尾空白后为空或超过 16 个字素（%j）→ 20001 [nickname]，什么都不写',
  async (nickname) => {
    const s = await setup(h);
    const target = await user(h, s.appId);
    const before = await snapshot(h, s.appId);
    const response = await edit(s, target.id, { nickname, reason: REASON });
    await rejected(response, 20001, { fields: ['nickname'] });
    expect(await snapshot(h, s.appId)).toEqual(before);
  },
);

it('[AC-B1-27b#30] 昵称未过内容安全审核 → 20001 [nickname] nickname_sensitive；同次改的手机号也不保存、会话不动', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await devices(h, s.clock, target, 2);
  const before = await snapshot(h, s.appId);
  for (const body of [
    { nickname: `小${SEED_WORD}狸`, reason: REASON },
    { nickname: `小${SEED_WORD}狸`, phone: testPhone(), reason: REASON },
  ]) {
    const response = await edit(s, target.id, body);
    await rejected(response, 20001, { fields: ['nickname'], reason: 'nickname_sensitive' });
  }
  expect(await snapshot(h, s.appId)).toEqual(before);
});

it('[AC-B1-27b#31] 去首尾空白后与现昵称相同即视为未改：不送审、不写，只记一条审计', async () => {
  const s = await setup(h);
  // Written straight into the row: a current nickname the review would refuse.
  const current = `旧${SEED_WORD}名`;
  const target = await user(h, s.appId, { nickname: current, month: MONTH, count: 2 });
  const before = await snapshot(h, s.appId);
  const body = { nickname: ` ${current} `, reason: REASON };
  const data = await ok(await edit(s, target.id, body));
  expect(data.nickname).toBe(current);
  const after = await snapshot(h, s.appId);
  expect({ ...after, audits: [] }).toEqual({ ...before, audits: [] });
  expect(after.audits).toHaveLength(before.audits.length + 1);
});

it('[AC-B1-27b#32] 一次同时改手机号与昵称：两项都生效，会话作废，只写一条审计', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await devices(h, s.clock, target, 2);
  const before = await snapshot(h, s.appId);
  const next = testPhone();
  const body = { phone: next, nickname: '小狸', reason: REASON };
  const data = await ok(await edit(s, target.id, body));
  expect(data).toMatchObject({ nickname: '小狸', phone_masked: masked(next) });
  expect(await row(h, target)).toMatchObject({ nickname: '小狸', phone_hmac: hmacOf(h, next) });
  const now = s.clock.now();
  for (const entry of await sessionsOf(h, target)) {
    expect(entry).toMatchObject({ revoked_at: now, revoke_reason: 'phone_changed' });
  }
  const after = await snapshot(h, s.appId);
  expect(after.audits).toHaveLength(before.audits.length + 1);
});
