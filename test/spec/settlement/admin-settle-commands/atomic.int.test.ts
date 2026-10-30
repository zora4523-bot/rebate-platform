// B2-09f atomicity rule tests (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml, the
// five writes of CT-24zd — the batch change and its audit record commit together (规划/02: every
// write of the console is audited; the audit writer on the command's transaction, as the recon
// close and write-off). A failure of the audit INSERT answers 5xx and leaves the batches, items,
// orders, differences and idempotency records as they were; the request can then be sent again. A
// failed launch may leave its settle_jobs row failed (B2-04r: the same key retries it). Requests go
// through the real admin entry; the fault is a one-shot plugin on its database handle (kit.ts).
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  CANCEL_ACTION,
  CONFIRM_ACTION,
  REJECT_ACTION,
  RESUME_ACTION,
  SUPPLEMENT_ACTION,
  allBatches,
  answer,
  audits,
  batchNow,
  creditSwitch,
  everything,
  expected,
  fixture,
  launched,
  newKey,
  seedBatch,
  seedBill,
  seedOrder,
  setSwitch,
  suite,
  versionOf,
  withCommandsAdmin,
  type AdminSent,
  type BatchRow,
  type CommandsAdmin,
  type Fixture,
} from './kit.ts';

const s = suite();

/** A failed attempt: 5xx, the fault tripped, the batch as it was, no audit record of the action. */
async function failsWhole(
  h: CommandsAdmin,
  f: Fixture,
  action: string,
  batch: BatchRow,
  send: () => Promise<AdminSent>,
): Promise<void> {
  const before = await everything(f);
  h.fault.action = action;
  await answer(await send(), 50001);
  expect(h.fault.tripped).toBe(1);
  expect(h.fault.action).toBe(null);
  expect(await batchNow(f, batch)).toEqual(batch);
  expect(await everything(f)).toEqual(before);
  await answer(await send(), 0);
  expect(await audits(f, action)).toHaveLength(1);
}

it('[AC-B2-09f#41] 确认的审计写入失败 → 5xx，整笔回滚：全部批次仍是 DRAFT、没有审计；重发成功', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const first = await seedBatch(f, bill);
  const second = await seedBatch(f, bill, { platform: 'jd' });
  await withCommandsAdmin(f, async (h) => {
    await failsWhole(h, f, CONFIRM_ACTION, second, () =>
      h.confirm(bill.bill_id, { expected_batches: expected([first, second]) }),
    );
    expect((await batchNow(f, first)).status).toBe('CONFIRMED');
    expect((await batchNow(f, second)).status).toBe('CONFIRMED');
  });
});

it('[AC-B2-09f#42] 撤销定时的审计写入失败 → 5xx，批次仍是 CONFIRMED + SCHEDULED；重发成功', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const batch = await seedBatch(f, bill, { status: 'CONFIRMED', settle_mode: 'SCHEDULED' });
  await withCommandsAdmin(f, async (h) => {
    await failsWhole(h, f, CANCEL_ACTION, batch, () =>
      h.cancelSchedule(batch.batch_id, versionOf(batch)),
    );
    expect((await batchNow(f, batch)).status).toBe('DRAFT');
  });
});

it('[AC-B2-09f#43] 驳回的审计写入失败 → 5xx，批次仍是 DRAFT；重发成功', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const batch = await seedBatch(f, bill);
  await withCommandsAdmin(f, async (h) => {
    await failsWhole(h, f, REJECT_ACTION, batch, () =>
      h.reject(batch.batch_id, { ...versionOf(batch), reason: '驳回' }),
    );
    expect((await batchNow(f, batch)).status).toBe('CANCELLED');
  });
});

it('[AC-B2-09f#44] 继续执行的审计写入失败 → 5xx，批次仍是 PARTIAL；重发成功', async () => {
  const f = fixture(s);
  await setSwitch(f, creditSwitch('taobao'), true);
  const bill = await seedBill(f, '2026-09');
  const batch = await seedBatch(f, bill, { status: 'PARTIAL' });
  await withCommandsAdmin(f, async (h) => {
    await failsWhole(h, f, RESUME_ACTION, batch, () => h.resume(batch.batch_id, versionOf(batch)));
    expect((await batchNow(f, batch)).status).toBe('EXECUTING');
  });
});

it('[AC-B2-09f#45] 发起补充的审计写入失败 → 5xx，不留批次、明细、差错与幂等记录；同一 Idempotency-Key 重发生成批次，审计一条', async () => {
  const f = fixture(s);
  await setSwitch(f, creditSwitch('taobao'), true);
  const bill = await seedBill(f, '2026-09');
  await seedOrder(f);
  await seedOrder(f, { commissionFen: 1100n });
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    const key = newKey();
    h.fault.action = SUPPLEMENT_ACTION;
    await answer(await h.supplement(bill.bill_id, { platform: 'taobao' }, { key }), 50001);
    expect(h.fault.tripped).toBe(1);
    const after = await everything(f);
    for (const part of ['batches', 'items', 'orders', 'diffs', 'audits', 'idempotency'] as const) {
      expect(after[part]).toEqual(before[part]);
    }

    const data = await launched(await h.supplement(bill.bill_id, { platform: 'taobao' }, { key }));
    expect(data.batch_ids).toHaveLength(1);
    expect(await allBatches(f)).toHaveLength(1);
    expect(await audits(f, SUPPLEMENT_ACTION)).toHaveLength(1);
  });
});
