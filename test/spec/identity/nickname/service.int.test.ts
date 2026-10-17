// B1-20d change-nickname use case with an injected NicknameReviewPort (review outage, review
// error, the prod fail-close review, check order, concurrency). Real PG through the me kit; the
// use case is built inside each test (its skeleton throws NotImplemented until implemented).
// Sources: 08 BR-ID-39 (+ 细则), BR-AI-18 (fail-close); 10 AC-S1-61 ④⑤; task brief §9.3 #5–#7,
// #10, #11, §9.4; review-first (保存前审核) and no row lock held over the review: §9.3 #5, #10.
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { memoryLogger } from '../sms-codes/kit.ts';
import {
  changeLines,
  closeKit,
  columns,
  FIXTURE_MONTH,
  gatedReview,
  heldReview,
  me,
  NICKNAME,
  nicknameFixture,
  nicknameService,
  openKit,
  reviewModule,
  scriptedReview,
  within,
  type Kit,
  type UpdateResult,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
});

const SENSITIVE: UpdateResult = { code: 20001, data: { reason: 'nickname_sensitive' } };

for (const [label, verdict] of [
  ['审核返回 unavailable（超时 / 不可用）', 'unavailable'],
  ['审核抛错', new Error('review exploded')],
] as const) {
  it(`[AC-B1-20d#5] ${label} → fail-close：20001 reason=nickname_sensitive，不计次、不改库，另记不含昵称原文的 warn`, async () => {
    const f = await nicknameFixture(kit);
    const before = await columns(f);
    const review = scriptedReview(verdict);
    const { logger, lines } = memoryLogger();
    const service = await nicknameService(kit, review.port, logger);
    expect(await service.update({ appId: f.appId, userId: f.uid, nickname: ' 小狸秘密 ' })).toEqual(
      SENSITIVE,
    );
    expect(review.calls).toEqual([{ appId: f.appId, text: '小狸秘密' }]);
    expect(await columns(f)).toEqual(before);
    const warns = lines.filter((line) => (JSON.parse(line) as { level: number }).level === 40);
    expect(warns.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain('小狸秘密');
    expect(changeLines(lines)).toEqual([]);
  });
}

it('[AC-B1-20d#4] 审核 hit → 20001 reason=nickname_sensitive，不计次、不改库、不写改动日志', async () => {
  const f = await nicknameFixture(kit);
  const before = await columns(f);
  const review = scriptedReview('hit');
  const { logger, lines } = memoryLogger();
  const service = await nicknameService(kit, review.port, logger);
  expect(await service.update({ appId: f.appId, userId: f.uid, nickname: '小狸' })).toEqual(
    SENSITIVE,
  );
  expect(await columns(f)).toEqual(before);
  expect(changeLines(lines)).toEqual([]);
});

it('[AC-B1-20d#6] prod 的审核恒 fail-close：任何文本都是 unavailable，经用例回 20001 nickname_sensitive、不改库', async () => {
  const { createNicknameReview } = await reviewModule();
  const prod = createNicknameReview('prod');
  for (const text of ['小狸', 'hello', '凑狸']) {
    expect(await prod.review({ appId: 'app_prod', text })).toBe('unavailable');
  }
  const f = await nicknameFixture(kit);
  const before = await columns(f);
  const service = await nicknameService(kit, prod, memoryLogger().logger);
  expect(await service.update({ appId: f.appId, userId: f.uid, nickname: '小狸' })).toEqual(
    SENSITIVE,
  );
  expect(await columns(f)).toEqual(before);
});

it('[AC-B1-20d#5] 审核 pass 才保存：审核收到 (appId, 去首尾空白后的文本)，成功回 {code:0}', async () => {
  const f = await nicknameFixture(kit);
  const review = scriptedReview('pass');
  const service = await nicknameService(kit, review.port, memoryLogger().logger);
  expect(await service.update({ appId: f.appId, userId: f.uid, nickname: '\t小狸 ' })).toEqual({
    code: 0,
  });
  expect(review.calls).toEqual([{ appId: f.appId, text: '小狸' }]);
  expect(await columns(f)).toMatchObject({ nickname: '小狸', month: FIXTURE_MONTH, count: 1 });
});

it('[AC-B1-20d#15] 检查顺序：长度不合格先于一切（20001 fields，不审核），即使当月次数已用完', async () => {
  const f = await nicknameFixture(kit, { month: FIXTURE_MONTH, count: 3 });
  const review = scriptedReview('pass');
  const service = await nicknameService(kit, review.port, memoryLogger().logger);
  expect(
    await service.update({ appId: f.appId, userId: f.uid, nickname: '狸'.repeat(17) }),
  ).toEqual({ code: 20001, data: { fields: ['nickname'] } });
  expect(await service.update({ appId: f.appId, userId: f.uid, nickname: '  ' })).toEqual({
    code: 20001,
    data: { fields: ['nickname'] },
  });
  expect(review.calls).toEqual([]);
});

it('[AC-B1-20d#15] 检查顺序：当月次数已用完 → 30415，不调用审核（即使审核会命中）', async () => {
  const f = await nicknameFixture(kit, { month: FIXTURE_MONTH, count: 3 });
  const before = await columns(f);
  const review = scriptedReview('hit');
  const service = await nicknameService(kit, review.port, memoryLogger().logger);
  expect(await service.update({ appId: f.appId, userId: f.uid, nickname: '小狸' })).toEqual({
    code: 30415,
  });
  expect(review.calls).toEqual([]);
  expect(await columns(f)).toEqual(before);
});

it('[AC-B1-20d#10] 与现值相同 → {code:0}，不审核、不计次、不改行、不写改动日志', async () => {
  const f = await nicknameFixture(kit, { month: FIXTURE_MONTH, count: 2 });
  const before = await columns(f);
  const review = scriptedReview('unavailable');
  const { logger, lines } = memoryLogger();
  const service = await nicknameService(kit, review.port, logger);
  expect(
    await service.update({ appId: f.appId, userId: f.uid, nickname: ` ${NICKNAME}\n` }),
  ).toEqual({ code: 0 });
  expect(review.calls).toEqual([]);
  expect(await columns(f)).toEqual(before);
  expect(changeLines(lines)).toEqual([]);
});

it('[AC-B1-20d#11] 同一用户并发 5 个合法修改（本月 0 次）→ 恰 3 个 0、2 个 30415，库里计数为 3', async () => {
  const f = await nicknameFixture(kit);
  const review = gatedReview(5);
  const { logger, lines } = memoryLogger();
  const service = await nicknameService(kit, review.port, logger);
  const names = ['并发一', '并发二', '并发三', '并发四', '并发五'];
  const results = await Promise.all(
    names.map((nickname) => service.update({ appId: f.appId, userId: f.uid, nickname })),
  );
  const codes = results.map((result) => result.code).sort((a, b) => a - b);
  expect(codes).toEqual([0, 0, 0, 30415, 30415]);
  const after = await columns(f);
  expect(after.count).toBe(3);
  expect(after.month).toBe(FIXTURE_MONTH);
  const winners = names.filter((_, index) => results[index]!.code === 0);
  expect(winners).toContain(after.nickname);
  expect(changeLines(lines)).toHaveLength(3);
});

it('[AC-B1-20d#11] 并发时已用 2 次 → 5 个里恰 1 个成功，计数为 3、不超过上限', async () => {
  const f = await nicknameFixture(kit, { month: FIXTURE_MONTH, count: 2 });
  const review = gatedReview(5);
  const service = await nicknameService(kit, review.port, memoryLogger().logger);
  const results = await Promise.all(
    ['甲', '乙', '丙', '丁', '戊'].map((nickname) =>
      service.update({ appId: f.appId, userId: f.uid, nickname }),
    ),
  );
  expect(results.filter((result) => result.code === 0)).toHaveLength(1);
  expect(results.filter((result) => result.code === 30415)).toHaveLength(4);
  expect((await columns(f)).count).toBe(3);
});

for (const [verdict, expected, after] of [
  ['pass', { code: 0 }, { nickname: '小狸', month: FIXTURE_MONTH, count: 2 }],
  ['hit', SENSITIVE, { nickname: NICKNAME, month: FIXTURE_MONTH, count: 1 }],
] as const) {
  it(`[AC-B1-20d#16] 先审核、后保存：审核未返回前库里与 GET /v1/me 仍是旧昵称与旧计数、行未被锁；审核 ${verdict} 后才定结果`, async () => {
    const f = await nicknameFixture(kit, { month: FIXTURE_MONTH, count: 1 });
    const before = await columns(f);
    const held = heldReview();
    const { logger, lines } = memoryLogger();
    const service = await nicknameService(kit, held.port, logger);
    const pending = service.update({ appId: f.appId, userId: f.uid, nickname: '小狸' });
    pending.catch(() => undefined);
    await within(
      Promise.race([
        held.reached,
        pending.then(() => {
          throw new Error('the change settled before its review answered');
        }),
      ]),
      3_000,
      'the use case entering review',
    );
    // Let any write started alongside the review land before looking.
    await delay(200);
    expect(held.calls).toEqual([{ appId: f.appId, text: '小狸' }]);
    // Another connection sees the old row: nothing was saved ahead of the review.
    expect(await columns(f)).toEqual(before);
    expect(me(kit, await f.get()).nickname).toBe(NICKNAME);
    // And the row is not locked while the review is pending (§9.3 #10).
    await within(
      kit.suite.db.transaction().execute(async (trx) => {
        await sql`SELECT id FROM app.users WHERE app_id = ${f.appId} AND id = ${f.uid}
          FOR UPDATE NOWAIT`.execute(trx);
      }),
      3_000,
      'locking the user row during the review',
    );
    expect(changeLines(lines)).toEqual([]);

    held.answer(verdict);
    expect(await within(pending, 3_000, 'the change after its review answered')).toEqual(expected);
    expect(await columns(f)).toMatchObject(after);
    expect(changeLines(lines)).toHaveLength(verdict === 'pass' ? 1 : 0);
  });
}
