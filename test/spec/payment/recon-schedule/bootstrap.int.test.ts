// B2-15m worker-entry rule test (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-07（每日 T+1 对账）；B2-15j
// 留项（首个日跑无入队，须人工入队）。The real worker entry (bootstrap.createWorkerContext: every module
// of the worker, its init and bootstrap hooks) on the fixture's database and clock; only its JOB_QUEUE
// is a recorder, never started. After bootstrap, with nothing enqueued by hand, the entry itself
// enqueues the App's daily bill.recon (the B1-22b chain start: a short delay after bootstrap is
// allowed, a minute at most). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { until } from '../close/kit.ts';
import { enable, suite } from '../orders/kit.ts';
import { NEXT_DAY, paidOrder, recon } from '../recon/kit.ts';
import { BILL_RECON_JOB, PAY_QUEUE, startWorker, workerReconSends } from './kit.ts';

const s = suite();

/** How long after bootstrap the first seed may take (real time). */
const SEED_WITHIN_MS = 60_000;

it('[AC-B2-15m#7] worker 入口启动（2026-10-22 01:00 +08:00）后无需人工入队：一分钟内由入口自己为有收款记录的 App 入队 bill.recon（队列 pay、账单日 2026-10-21、不带渠道），同一 App 的种子都用同一 singletonKey（含 App 与账单日）', async () => {
  const r = await recon(s, NEXT_DAY);
  await enable(r.f);
  await paidOrder(r, 'wechat_pay');
  const appId = r.f.subject.app_id;
  const worker = await startWorker(r.f);
  try {
    const seeded = await until(
      async () => workerReconSends(worker, appId).length > 0,
      SEED_WITHIN_MS,
    );
    expect(seeded, `a bill.recon of ${appId} enqueued by the worker entry after bootstrap`).toBe(
      true,
    );
    const sent = workerReconSends(worker, appId);
    for (const job of sent) {
      expect(job.queue).toBe(PAY_QUEUE);
      expect(job.name).toBe(BILL_RECON_JOB);
      expect(job.payload).toMatchObject({ app_id: appId, bill_date: '2026-10-21' });
      expect(job.payload['pay_channel']).toBeUndefined();
    }
    const keys = new Set(sent.map((job) => job.options.singletonKey ?? ''));
    expect(keys.size, 'one singletonKey per App and bill day').toBe(1);
    const [key] = [...keys];
    expect(key).toContain(appId);
    expect(key).toContain('2026-10-21');
  } finally {
    await worker.close();
  }
}, 150_000);
