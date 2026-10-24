// B2-06e ⑧ (规划/08 BR-WDR-14; 规划/12 §5.4): the point and delay the crash recovery scan picks —
// the first point n with T + offset(n) > now (defaults 1, 5, 30, 120 minutes, then every 120),
// delaySeconds = T + offset(n) − now, singletonKey and payload with the withdrawal's own
// execute_seq; any transfer attempt result (a pending one too) counts as sent; exactly T + 24 hours
// is due for needs_manual. payout.enabled = off and payout.queue_paused = true do not matter. The
// scan covers every app of the database: this file holds a single test so the counts are its own.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DAY,
  HOUR,
  MINUTE,
  NEEDS_MANUAL_ALERT,
  NOW,
  TIMEOUT,
  at,
  close,
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

it('[AC-B2-06e#8] 补投的时点与延迟：T+30 秒 → point 0 延迟 30 秒（转账尝试仍 pending 也算）；T+7 分（execute_seq 3）→ point 2 延迟 1380 秒；T+3 小时 → point 4 延迟 3600 秒；T+23 时 59 分 → point 15 延迟 60 秒；恰 T+24 小时 → 置 needs_manual；开关关着也照做', async () => {
  const f = await setup(h);
  await f.set('payout.enabled', false);
  await f.set('payout.queue_paused', true);
  const p0 = await f.seedPaying(at(-30_000), {}, 'pending');
  const p2 = await f.seedPaying(at(-7 * MINUTE), { executeSeq: 3 });
  const p4 = await f.seedPaying(at(-3 * HOUR));
  const p15 = await f.seedPaying(at(-(DAY - MINUTE)));
  const due = await f.seedPaying(at(-DAY));
  const recovery = f.recovery();
  const dueBefore = await withdrawal(f, due.id);

  await expect(recovery.scan(f.h.db, NOW)).resolves.toEqual({
    scanned: 5,
    enqueued: 4,
    manual: 1,
  });
  expect(await jobsOf(f, p0.id)).toEqual([queryJobRow(p0, 0, 30)]);
  expect(await jobsOf(f, p2.id)).toEqual([queryJobRow(p2, 2, 1380, 3)]);
  expect(await jobsOf(f, p4.id)).toEqual([queryJobRow(p4, 4, 3600)]);
  expect(await jobsOf(f, p15.id)).toEqual([queryJobRow(p15, 15, 60)]);
  expect(await jobsOf(f, due.id)).toEqual([]);
  expect(await withdrawal(f, due.id)).toEqual({
    ...dueBefore,
    needs_manual: true,
    row_version: dueBefore.row_version + 1,
    updated_at: expect.any(Date),
  });
  expect(f.logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ withdrawal_id: due.id, out_biz_no: due.outBizNo }),
    NEEDS_MANUAL_ALERT,
  );
  for (const w of [p0, p2, p4, p15]) {
    expect(await withdrawal(f, w.id)).toMatchObject({ status: 'PAYING', needs_manual: false });
  }
});
