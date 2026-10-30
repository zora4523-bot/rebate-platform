// B2-09f read-side rule tests (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// AdminSettleBatch.row_version is on every batch of getAdminSettleBill (D10-437 ③), the value the
// batch commands take as expected_row_version; AdminSettleBillStatus: each supplement launch is one
// round, the kind supplement batches sharing (platform, created_at), and created_at compares at the
// column's microsecond precision (B2-09d money S2): two launches less than a millisecond apart are
// two rounds, on the list and on the detail. The created_at values are written as text, so the
// microseconds reach the column. Requests go through the real admin entry (kit.ts). Top-level it()
// only (规划/11 §4.3).
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  answer,
  batchesOf,
  billOf,
  fixture,
  seedBatch,
  seedBill,
  suite,
  versionOf,
  withCommandsAdmin,
  type BatchRow,
  type BatchSeed,
} from './kit.ts';

const s = suite();
const EARLIER = '2026-10-28T02:00:00.123456Z';
const LATER = '2026-10-28T02:00:00.123789Z';

/** Batch ids sorting against the time order: a tie break must not decide the latest round. */
function lowId(): string {
  return `00000000-0000-7000-8000-${randomBytes(6).toString('hex')}`;
}

function highId(): string {
  return `ffffffff-0000-7000-8000-${randomBytes(6).toString('hex')}`;
}

/** batch_id → in_current_round. */
async function rounds(batches: Promise<Record<string, unknown>[]>) {
  const rows = await batches;
  return new Map(rows.map((b) => [b['batch_id'], b['in_current_round']]));
}

it('[AC-B2-09f#38] row_version 恒在详情的批次上：每种状态、首批与补充都返回存储值（含 0），settle.bill 与 fund.view 读到的一样；用它做 expected_row_version 的写操作成功后详情里 +1', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const seeds: BatchSeed[] = [
    { status: 'DRAFT', row_version: 0 },
    { status: 'CONFIRMED', settle_mode: 'SCHEDULED', row_version: 1 },
    { status: 'EXECUTING', row_version: 2 },
    { status: 'PARTIAL', row_version: 3 },
    { status: 'DONE', row_version: 4 },
    { status: 'CANCELLED', row_version: 7 },
    { status: 'DRAFT', kind: 'supplement', row_version: 9 },
  ];
  const rows: BatchRow[] = [];
  for (const seed of seeds) rows.push(await seedBatch(f, bill, seed));
  const scheduled = rows[1]!;
  await withCommandsAdmin(f, async (h) => {
    const want = new Map(rows.map((b) => [b.batch_id, b.row_version]));
    for (const who of [h.biller, h.viewer]) {
      const batches = await batchesOf(await h.detail(bill.bill_id, who));
      expect(new Map(batches.map((b) => [b['batch_id'], b['row_version']]))).toEqual(want);
    }
    await answer(await h.cancelSchedule(scheduled.batch_id, versionOf(scheduled)), 0);
    const after = await batchesOf(await h.detail(bill.bill_id));
    expect(after.find((b) => b['batch_id'] === scheduled.batch_id)?.['row_version']).toBe(2);
  });
});

it('[AC-B2-09f#39] 分轮键到微秒：同平台两次补充发起的 created_at 相差不足 1 毫秒时是两轮，最近一轮只取时刻更晚的（不靠 batch_id 打平），详情的 in_current_round 与列表、详情的派生状态都按它；created_at 完全相同的同平台批次仍是一轮；批次按 created_at 的微秒顺序排列', async () => {
  const f = fixture(s);
  // The older launch still waits, the later one is executed: one round would be issued.
  const split = await seedBill(f, '2026-09');
  const older = highId();
  const newer = lowId();
  await seedBatch(f, split, {
    batch_id: older,
    kind: 'supplement',
    status: 'DRAFT',
    created_at: EARLIER,
  });
  await seedBatch(f, split, {
    batch_id: newer,
    kind: 'supplement',
    status: 'DONE',
    created_at: LATER,
  });
  // One launch of two batches at the same microsecond, the older launch 333 µs before.
  const together = await seedBill(f, '2026-08');
  const old = await seedBatch(f, together, {
    kind: 'supplement',
    status: 'DONE',
    created_at: EARLIER,
  });
  const a = await seedBatch(f, together, {
    kind: 'supplement',
    status: 'DONE',
    created_at: LATER,
  });
  const b = await seedBatch(f, together, {
    kind: 'supplement',
    status: 'DRAFT',
    created_at: LATER,
  });
  await withCommandsAdmin(f, async (h) => {
    const splitSent = await h.detail(split.bill_id);
    expect(await rounds(batchesOf(splitSent))).toEqual(
      new Map([
        [older, false],
        [newer, true],
      ]),
    );
    expect((await batchesOf(splitSent)).map((batch) => batch['batch_id'])).toEqual([older, newer]);
    const splitBill = await billOf(splitSent);
    expect({ status: splitBill['status'], drafts: splitBill['draft_batch_count'] }).toEqual({
      status: 'settled',
      drafts: 1,
    });

    const togetherSent = await h.detail(together.bill_id);
    expect(await rounds(batchesOf(togetherSent))).toEqual(
      new Map([
        [old.batch_id, false],
        [a.batch_id, true],
        [b.batch_id, true],
      ]),
    );
    expect((await billOf(togetherSent))['status']).toBe('issued');

    expect(await h.listed()).toEqual({ [split.bill_id]: 'settled', [together.bill_id]: 'issued' });
  });
});

it('[AC-B2-09f#40] 分轮键到微秒，同刻并列仍按 batch_id：两个平台的发起 created_at 完全相同时是两轮，取含最大 batch_id 的一轮；相差不足 1 毫秒时不走并列，取时刻更晚的一轮（即使它的 batch_id 更小）', async () => {
  const f = fixture(s);
  const tied = await seedBill(f, '2026-09');
  const tiedLow = lowId();
  const tiedHigh = highId();
  await seedBatch(f, tied, {
    batch_id: tiedLow,
    kind: 'supplement',
    platform: 'taobao',
    status: 'DONE',
    created_at: LATER,
  });
  await seedBatch(f, tied, {
    batch_id: tiedHigh,
    kind: 'supplement',
    platform: 'jd',
    status: 'DRAFT',
    created_at: LATER,
  });
  const apart = await seedBill(f, '2026-08');
  const apartOlder = highId();
  const apartNewer = lowId();
  await seedBatch(f, apart, {
    batch_id: apartOlder,
    kind: 'supplement',
    platform: 'jd',
    status: 'DRAFT',
    created_at: EARLIER,
  });
  await seedBatch(f, apart, {
    batch_id: apartNewer,
    kind: 'supplement',
    platform: 'taobao',
    status: 'DONE',
    created_at: LATER,
  });
  await withCommandsAdmin(f, async (h) => {
    const tiedSent = await h.detail(tied.bill_id);
    expect(await rounds(batchesOf(tiedSent))).toEqual(
      new Map([
        [tiedLow, false],
        [tiedHigh, true],
      ]),
    );
    expect((await billOf(tiedSent))['status']).toBe('issued');

    const apartSent = await h.detail(apart.bill_id);
    expect(await rounds(batchesOf(apartSent))).toEqual(
      new Map([
        [apartOlder, false],
        [apartNewer, true],
      ]),
    );
    expect((await billOf(apartSent))['status']).toBe('settled');
  });
});
