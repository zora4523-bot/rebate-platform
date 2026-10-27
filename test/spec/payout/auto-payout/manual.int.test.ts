// BR-WDR-26 (manual → review_deadline = created_at + 24 working hours, the working-day calendar of
// the console) and BR-WDR-30 可追溯 (rule_version: the configuration group's version, increased on
// every save) on the manual path of the consumer.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { MINUTE, NOW, TIMEOUT, close, decision, key, open, setup, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-11c#40] review_deadline 从 created_at 起算而非判定时刻：周一 10:00 申请、16:00 才判定 manual，期限仍为周二 10:00（+08:00）', async () => {
  const f = await setup(h);
  const id = await f.start(35_000n);
  const later = new Date(NOW.getTime() + 360 * MINUTE);
  f.clock.set(later);
  await f.consumer().consume(await f.event(id));
  expect(await f.row(id)).toMatchObject({
    status: 'PENDING_REVIEW',
    review_mode: 'manual',
    review_deadline: new Date('2026-10-20T02:00:00.000Z'),
    auto_decision: decision('manual', ['max_amount'], {}, later),
  });
});

it('[AC-B2-11c#41] review_deadline 按工作日历：周二为法定节假日时，周一 10:00 申请的期限顺延到周三 10:00', async () => {
  const f = await setup(h);
  await f.set('calendar.cn_holidays.2026', ['2026-10-20']);
  await f.set('calendar.cn_makeup_workdays.2026', []);
  const id = await f.start(35_000n);
  await f.consumer().consume(await f.event(id));
  expect(await f.row(id)).toMatchObject({
    review_mode: 'manual',
    review_deadline: new Date('2026-10-21T02:00:00.000Z'),
  });
});

it('[AC-B2-11c#42] rule_version 是非负整数；配置未变时两次判定同一版本，再次保存自动到账配置后版本递增', async () => {
  const f = await setup(h, { balance: 200_000n });
  await f.set(key('max_amount_fen'), 30_000);
  const first = await f.start(35_000n);
  const second = await f.start(35_000n);
  const consumer = f.consumer();
  await consumer.consume(await f.event(first));
  await consumer.consume(await f.event(second));
  const a = (await f.row(first)).auto_decision as { rule_version: unknown };
  const b = (await f.row(second)).auto_decision as { rule_version: unknown };
  expect(Number.isSafeInteger(a.rule_version)).toBe(true);
  expect(a.rule_version as number).toBeGreaterThanOrEqual(0);
  expect(b.rule_version).toBe(a.rule_version);

  await f.set(key('max_amount_fen'), 30_000);
  const third = await f.start(35_000n);
  await consumer.consume(await f.event(third));
  const c = (await f.row(third)).auto_decision as { rule_version: unknown };
  expect(Number.isSafeInteger(c.rule_version)).toBe(true);
  expect(c.rule_version as number).toBeGreaterThan(a.rule_version as number);
});
