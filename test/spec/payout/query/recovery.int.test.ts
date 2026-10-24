// B2-06e ⑧ (规划/08 BR-WDR-14; 规划/12 §5.4 crash recovery): scan(handle, now) looks at every
// PAYING withdrawal with needs_manual = false and a transfer attempt. One without a query job gets
// the job of the next point (the first n with T + offset(n) > now); one whose job of that point is
// already queued gets nothing new (same singletonKey: send returns null); one past T + 24 hours
// gets needs_manual = true and the alert instead of a job. needs_manual withdrawals, other states
// and PAYING withdrawals without a transfer attempt are not touched. A second scan is idempotent.
// The scan covers every app of the database: this file holds a single test so the counts are its
// own.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DAY,
  MINUTE,
  NEEDS_MANUAL_ALERT,
  NOW,
  TIMEOUT,
  at,
  close,
  expectNoPayeeInLogs,
  jobsOf,
  open,
  queryJobRow,
  setup,
  withdrawal,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-06e#8] 崩溃恢复：无任务的单补投下一时点（T+7 分 → point 2、延迟 23 分）；已有同键任务的不重复；已过 24 小时的置 needs_manual 并告警；needs_manual 单、非 PAYING 单、无转账尝试的单不碰；再扫一次不再投', async () => {
  const f = await setup(h);
  const missing = await f.seedPaying(at(-7 * MINUTE));
  const queued = await f.seedPaying(at(-7 * MINUTE));
  await f.seedQueued(queued, 2, 23 * 60);
  const late = await f.seedPaying(at(-(DAY + MINUTE)));
  const manual = await f.seedPaying(at(-30 * MINUTE));
  await f.markNeedsManual(manual);
  const paid = await f.seedPaying(at(-7 * MINUTE), { status: 'PAID_API' }, 'success');
  const failed = await f.seedPaying(at(-7 * MINUTE), { status: 'FAILED' });
  const fresh = await f.seedWithdrawal();
  const recovery = f.recovery();

  const untouched = [manual, paid, failed, fresh];
  const rowsBefore = await Promise.all(
    [missing, queued, ...untouched].map((w) => withdrawal(f, w.id)),
  );
  const lateBefore = await withdrawal(f, late.id);
  const queuedJobs = await jobsOf(f, queued.id);
  expect(queuedJobs).toEqual([queryJobRow(queued, 2, 23 * 60)]);

  await expect(recovery.scan(f.h.db, NOW)).resolves.toEqual({
    scanned: 3,
    enqueued: 1,
    manual: 1,
  });
  expect(await jobsOf(f, missing.id)).toEqual([queryJobRow(missing, 2, 23 * 60)]);
  expect(await jobsOf(f, queued.id)).toEqual(queuedJobs);
  expect(await jobsOf(f, late.id)).toEqual([]);
  for (const w of untouched) expect(await jobsOf(f, w.id)).toEqual([]);
  expect(
    await Promise.all([missing, queued, ...untouched].map((w) => withdrawal(f, w.id))),
  ).toEqual(rowsBefore);
  expect(await withdrawal(f, late.id)).toEqual({
    ...lateBefore,
    needs_manual: true,
    row_version: lateBefore.row_version + 1,
    updated_at: expect.any(Date),
  });
  expect(f.logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ withdrawal_id: late.id, out_biz_no: late.outBizNo }),
    NEEDS_MANUAL_ALERT,
  );
  const alerted = (): unknown[] =>
    f.logger.warn.mock.calls.filter((call) => call[1] === NEEDS_MANUAL_ALERT);
  expect(alerted()).toHaveLength(1);

  // A second scan (the hourly one): late is needs_manual now, the two others have their job.
  await expect(recovery.scan(f.h.db, NOW)).resolves.toEqual({
    scanned: 2,
    enqueued: 0,
    manual: 0,
  });
  expect(await jobsOf(f, missing.id)).toEqual([queryJobRow(missing, 2, 23 * 60)]);
  expect(await jobsOf(f, queued.id)).toEqual(queuedJobs);
  expect(alerted()).toHaveLength(1);
  expectNoPayeeInLogs(f);
});
