// B1-20d PATCH /v1/me rule tests at the HTTP level: real AppModule (APP_ENV=test, so the review is
// the local seed-list review over infra/sensitive-words.nickname.txt, which must name SEED_WORD).
// Red before implementation: updateMe is x-implementation planned, so no route is registered and
// PATCH /v1/me answers Fastify's 404; every case fails on its first status / envelope assertion.
// Sources: 08 BR-ID-39 (+ 细则); 04 §6.1; 10 AC-S1-61; task brief §9.3 #1–#4, #7, #9, §9.4.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  changeLines,
  closeKit,
  columns,
  exhaustedError,
  fieldsError,
  FIXTURE_MONTH,
  me,
  NICKNAME,
  nicknameFixture,
  ok,
  openKit,
  SEED_WORD,
  sensitiveError,
  type Kit,
  type NicknameFixture,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
});

const FAMILY = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}';
const ACCENTED = 'é';

async function unchanged(f: NicknameFixture, before: Awaited<ReturnType<typeof columns>>) {
  expect(await columns(f)).toEqual(before);
}

it('[AC-B1-20d#1] 成功改昵称：回 {code:0,data:{}}，存去首尾空白后的值，GET /v1/me 读到新值，本月计 1 次', async () => {
  const f = await nicknameFixture(kit);
  const before = await columns(f);
  ok(kit, await f.patch({ nickname: '  小狸  ' }));
  const after = await columns(f);
  expect(after.nickname).toBe('小狸');
  expect(after.month).toBe(FIXTURE_MONTH);
  expect(after.count).toBe(1);
  expect(after.row_version).toBe(before.row_version + 1);
  expect(after.updated_at).toBe(kit.clock.now().getTime());
  expect(me(kit, await f.get()).nickname).toBe('小狸');
});

for (const [label, nickname, expected] of [
  ['16 个 emoji 家庭（ZWJ 序列）', FAMILY.repeat(16), FAMILY.repeat(16)],
  ['16 个汉字', '狸'.repeat(16), '狸'.repeat(16)],
  ['16 个带组合附加符的字母', ACCENTED.repeat(16), ACCENTED.repeat(16)],
  ['去首尾空白后 16 个汉字', ` 　${'狸'.repeat(16)}\t `, '狸'.repeat(16)],
  ['1 个字', '狸', '狸'],
] as const) {
  it(`[AC-B1-20d#2] 字素簇边界：${label} → 通过`, async () => {
    const f = await nicknameFixture(kit);
    ok(kit, await f.patch({ nickname }));
    expect((await columns(f)).nickname).toBe(expected);
  });
}

for (const [label, nickname] of [
  ['17 个 emoji 家庭', FAMILY.repeat(17)],
  ['17 个汉字', '狸'.repeat(17)],
  ['17 个带组合附加符的字母', ACCENTED.repeat(17)],
  ['空串', ''],
  ['全空白（含全角空格、制表符、换行）', ' 　\t\n '],
] as const) {
  it(`[AC-B1-20d#2] 字素簇边界：${label} → 20001，data.fields 含 nickname，昵称与计数不变`, async () => {
    const f = await nicknameFixture(kit);
    const before = await columns(f);
    expect(fieldsError(kit, await f.patch({ nickname }))).toContain('nickname');
    await unchanged(f, before);
  });
}

for (const [label, body] of [
  ['带 avatar 字段', { nickname: '小狸', avatar: 'https://cdn.example.test/a.png' }],
  ['缺 nickname', {}],
  ['nickname 不是字符串', { nickname: 123 }],
  ['nickname 为 null', { nickname: null }],
] as const) {
  it(`[AC-B1-20d#3] 请求体${label} → 20001（data.fields），不改库`, async () => {
    const f = await nicknameFixture(kit);
    const before = await columns(f);
    expect(fieldsError(kit, await f.patch(body)).length).toBeGreaterThan(0);
    await unchanged(f, before);
  });
}

it('[AC-B1-20d#4] 昵称含种子敏感词 → 20001 只带 reason=nickname_sensitive，昵称不变、不计次', async () => {
  const f = await nicknameFixture(kit);
  const before = await columns(f);
  sensitiveError(kit, await f.patch({ nickname: `小狸${SEED_WORD}` }));
  await unchanged(f, before);
  expect(me(kit, await f.get()).nickname).toBe(NICKNAME);
  // Not counted: the month's 3 successful changes are all still there.
  for (const nickname of ['狸一', '狸二', '狸三']) ok(kit, await f.patch({ nickname }));
  expect((await columns(f)).count).toBe(3);
});

it('[AC-B1-20d#7] 当月成功 3 次后第 4 次 → 30415（HTTP 422），昵称停在第 3 次的值、计数为 3', async () => {
  const f = await nicknameFixture(kit);
  for (const [index, nickname] of ['狸一', '狸二', '狸三'].entries()) {
    ok(kit, await f.patch({ nickname }));
    expect(me(kit, await f.get()).nickname).toBe(nickname);
    expect((await columns(f)).count).toBe(index + 1);
  }
  const before = await columns(f);
  exhaustedError(kit, await f.patch({ nickname: '狸四' }));
  await unchanged(f, before);
  expect(before).toMatchObject({ nickname: '狸三', month: FIXTURE_MONTH, count: 3 });
});

it('[AC-B1-20d#8] 自然月按 +08:00：23:59:59.999 仍算当月（第 4 次 30415），次月 1 日 00:00:00 起重新计数', async () => {
  // 2031-06-30T23:59:59.999+08:00 = 2031-06-30T15:59:59.999Z (UTC still June either way).
  const f = await nicknameFixture(kit, { nickname: '狸零' });
  kit.clock.set('2031-06-30T15:59:59.999Z');
  for (const nickname of ['狸一', '狸二', '狸三']) ok(kit, await f.patch({ nickname }));
  expect(await columns(f)).toMatchObject({ month: '2031-06', count: 3 });
  exhaustedError(kit, await f.patch({ nickname: '狸四' }));
  // 2031-07-01T00:00:00+08:00 = 2031-06-30T16:00:00Z: UTC is still June, +08:00 is July.
  kit.clock.set('2031-06-30T16:00:00.000Z');
  ok(kit, await f.patch({ nickname: '狸四' }));
  expect(await columns(f)).toMatchObject({ nickname: '狸四', month: '2031-07', count: 1 });
});

it('[AC-B1-20d#8] 库里是上月已满 3 次 → 本月照常可改，月份换成本月、计数从 1 起', async () => {
  const f = await nicknameFixture(kit, { month: '2031-06', count: 3 });
  kit.clock.set('2031-06-30T16:00:00.000Z');
  ok(kit, await f.patch({ nickname: '小狸' }));
  expect(await columns(f)).toMatchObject({ nickname: '小狸', month: '2031-07', count: 1 });
});

it('[AC-B1-20d#8] 库里是本月（+08:00）已满 3 次 → 30415，不改库', async () => {
  const f = await nicknameFixture(kit, { month: '2031-06', count: 3 });
  kit.clock.set('2031-06-30T15:59:59.999Z');
  const before = await columns(f);
  exhaustedError(kit, await f.patch({ nickname: '小狸' }));
  await unchanged(f, before);
});

it('[AC-B1-20d#9] 建号时的系统默认昵称不计次：默认昵称用户本月仍有 3 次，改回默认形态也计次', async () => {
  const f = await nicknameFixture(kit, { nickname: 'default' });
  ok(kit, await f.patch({ nickname: '小狸' }));
  expect(await columns(f)).toMatchObject({ month: FIXTURE_MONTH, count: 1 });
  ok(kit, await f.patch({ nickname: f.nickname }));
  expect(await columns(f)).toMatchObject({ nickname: f.nickname, count: 2 });
  ok(kit, await f.patch({ nickname: '大狸' }));
  expect((await columns(f)).count).toBe(3);
  exhaustedError(kit, await f.patch({ nickname: '老狸' }));
  expect((await columns(f)).nickname).toBe('大狸');
});

it('[AC-B1-20d#10] 与现值相同（去空白后）→ 回 0，不计次、不改行、不写日志；当月次数用完时也回 0', async () => {
  const f = await nicknameFixture(kit);
  const before = await columns(f);
  const from = kit.lines.length;
  ok(kit, await f.patch({ nickname: `  ${NICKNAME} ` }));
  await unchanged(f, before);
  expect(changeLines(kit.lines.slice(from))).toEqual([]);

  const full = await nicknameFixture(kit, { month: FIXTURE_MONTH, count: 3 });
  const fullBefore = await columns(full);
  ok(kit, await full.patch({ nickname: NICKNAME }));
  await unchanged(full, fullBefore);
});

it('[AC-B1-20d#12] 成功改动写一行 pino info identity_nickname_changed：旧值只留首字 + ***，日志里没有完整旧值', async () => {
  const f = await nicknameFixture(kit);
  const from = kit.lines.length;
  ok(kit, await f.patch({ nickname: '小狸' }));
  const lines = kit.lines.slice(from);
  const changes = changeLines(lines);
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({
    level: 30,
    app_id: f.appId,
    user_id: f.uid,
    old_nickname: '凑***',
    new_nickname: '小狸',
    counted: true,
    month: FIXTURE_MONTH,
  });
  // NICKNAME = '凑狸用户 8000': neither it nor its tail after the first character is logged.
  for (const line of lines) {
    expect(line).not.toContain(NICKNAME);
    expect(line).not.toContain('狸用户 8000');
  }
});

it('[AC-B1-20d#12] 旧值首个字素簇是 emoji 家庭时整簇保留，其余一律 ***（不暴露长度）', async () => {
  const f = await nicknameFixture(kit, { nickname: `${FAMILY}小狸狸狸狸` });
  const from = kit.lines.length;
  ok(kit, await f.patch({ nickname: '小狸' }));
  const changes = changeLines(kit.lines.slice(from));
  expect(changes).toHaveLength(1);
  expect(changes[0]!['old_nickname']).toBe(`${FAMILY}***`);
  for (const line of kit.lines.slice(from)) expect(line).not.toContain('小狸狸狸狸');
});

it('[AC-B1-20d#13] 被拒（长度、敏感词、30415、多余字段）都不写 identity_nickname_changed', async () => {
  const f = await nicknameFixture(kit);
  const from = kit.lines.length;
  fieldsError(kit, await f.patch({ nickname: '   ' }));
  sensitiveError(kit, await f.patch({ nickname: `${SEED_WORD}狸` }));
  fieldsError(kit, await f.patch({ nickname: '小狸', avatar: 'x' }));
  const full = await nicknameFixture(kit, { month: FIXTURE_MONTH, count: 3 });
  exhaustedError(kit, await full.patch({ nickname: '小狸' }));
  expect(changeLines(kit.lines.slice(from))).toEqual([]);
});

it('[AC-B1-20d#14] 只改当前令牌本人那一行：同 app 的另一用户昵称、计数、版本都不变', async () => {
  const f = await nicknameFixture(kit);
  const other = await nicknameFixture(kit, { appId: f.appId, month: FIXTURE_MONTH, count: 1 });
  const otherBefore = await columns(other);
  ok(kit, await f.patch({ nickname: '小狸' }));
  expect((await columns(f)).nickname).toBe('小狸');
  expect(await columns(other)).toEqual(otherBefore);
  expect(me(kit, await other.get()).nickname).toBe(NICKNAME);
});
