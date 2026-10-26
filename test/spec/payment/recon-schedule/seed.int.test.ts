// B2-15m seed rule tests (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-07（每日 T+1 用渠道的交易账单核对：
// 账单日是 +08:00 会计日，运行日 D+1 核对 D）；payment/AGENTS.md 硬规则 5（会计日只用 @couli/domain，时间只读注入的
// Clock）、9（队列只经 JobQueue）。The seed of the daily chain (application/pay-recon-schedule.ts
// seedBillRecon) puts one bill.recon per App on queue pay for the bill day before the current
// +08:00 accounting day, keyed per App and bill day (B2-15j jobs/names.ts), so a restart merges into
// the queued run instead of adding one. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { enable, suite } from '../orders/kit.ts';
import { jobKit } from '../result/kit.ts';
import { NEXT_DAY, paidOrder, recon } from '../recon/kit.ts';
import {
  AT_ONCE_SECONDS,
  BILL_RECON_JOB,
  PAY_QUEUE,
  billDateOf,
  dailySends,
  dayEndMs,
  dueMs,
  reconJobs,
  seed,
  withQueue,
} from './kit.ts';

const s = suite();

/** 2026-10-22 01:00 +08:00 (kit NEXT_DAY; UTC still 10-21): before the 10-21 bill's daily run. */
const BEFORE_RUN = NEXT_DAY;
/** 2026-10-22 15:00 +08:00: past the daily run time of the 10-21 bill. */
const PAST_RUN = '2026-10-22T07:00:00.000Z';
/** The bill day before 2026-10-22 at +08:00. */
const PREVIOUS = '2026-10-21';

it('[AC-B2-15m#1] worker 种子（2026-10-22 01:00 +08:00，UTC 仍是 10-21）：每个有收款记录的 App 恰入队一个 bill.recon（队列 pay、账单日 2026-10-21 = 当前 +08:00 会计日的前一日、不带渠道），singletonKey 含 App 与账单日，到期时刻不早于现在且落在 T+1（10-22 +08:00）之内；再种一次（重启）用同一 singletonKey、同一账单日', async () => {
  const r = await recon(s, BEFORE_RUN);
  await enable(r.f);
  await paidOrder(r, 'wechat_pay');
  const other = await recon(s, BEFORE_RUN);
  await enable(other.f);
  await paidOrder(other, 'alipay');
  const apps = [r.f.subject.app_id, other.f.subject.app_id];

  await seed(r.kit);
  const nowMs = r.f.clock.now().getTime();
  const firstKeys: string[] = [];
  for (const appId of apps) {
    const sent = dailySends(r.kit, appId);
    expect(sent, `one daily bill.recon of ${appId}`).toHaveLength(1);
    const job = sent[0]!;
    expect(job.queue).toBe(PAY_QUEUE);
    expect(job.name).toBe(BILL_RECON_JOB);
    expect(job.payload).toMatchObject({ app_id: appId, bill_date: PREVIOUS });
    expect(job.payload['pay_channel']).toBeUndefined();
    const key = job.options.singletonKey ?? '';
    expect(key, 'singletonKey').toContain(appId);
    expect(key, 'singletonKey').toContain(PREVIOUS);
    expect(dueMs(r.f.clock, job)).toBeGreaterThanOrEqual(nowMs);
    expect(dueMs(r.f.clock, job), 'due on T+1').toBeLessThan(dayEndMs('2026-10-22'));
    firstKeys.push(key);
  }
  expect(new Set(firstKeys).size, 'one key per App').toBe(apps.length);

  await seed(r.kit);
  for (const [index, appId] of apps.entries()) {
    const sent = dailySends(r.kit, appId);
    expect(sent, `the restart's seed of ${appId}`).toHaveLength(2);
    expect(sent.map(billDateOf)).toEqual([PREVIOUS, PREVIOUS]);
    expect(sent.map((job) => job.options.singletonKey)).toEqual([
      firstKeys[index],
      firstKeys[index],
    ]);
  }
}, 60_000);

it('[AC-B2-15m#2] 首轮无需人工入队：worker 在 2026-10-22 15:00 +08:00（已过 10-21 账单的日跑时刻）才启动，种子仍是账单日 2026-10-21 的 bill.recon，且立即到期（延迟不超过 60 秒），不等到次日', async () => {
  const r = await recon(s, PAST_RUN);
  await enable(r.f);
  await paidOrder(r, 'alipay');
  await seed(r.kit);
  const sent = dailySends(r.kit, r.f.subject.app_id);
  expect(sent).toHaveLength(1);
  const job = sent[0]!;
  expect(job.payload).toMatchObject({ app_id: r.f.subject.app_id, bill_date: PREVIOUS });
  expect(job.options.delaySeconds ?? 0).toBeLessThanOrEqual(AT_ONCE_SECONDS);
}, 60_000);

it('[AC-B2-15m#3] 重启不重复入队（pg-boss 持久化）：两个先后启动的进程各种一次，队列 pay 里该 App 的 bill.recon 只有一个待执行（账单日 2026-10-21）', async () => {
  const r = await recon(s, BEFORE_RUN);
  await enable(r.f);
  await paidOrder(r, 'wechat_pay');
  const appId = r.f.subject.app_id;
  for (let start = 0; start < 2; start += 1) {
    await withQueue(r.f, async (queue) => {
      const kit = await jobKit(r.f, r.channels, { queue });
      await seed(kit);
    });
  }
  const jobs = await reconJobs(r.f, appId);
  expect(jobs, 'one queued bill.recon of the app').toHaveLength(1);
  const job = jobs[0]!;
  expect(job.state).toBe('created');
  expect(job.payload).toMatchObject({ app_id: appId, bill_date: PREVIOUS });
  expect(job.singleton_key ?? '').toContain(appId);
  expect(job.singleton_key ?? '').toContain(PREVIOUS);
}, 60_000);
