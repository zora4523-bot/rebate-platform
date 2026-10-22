import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { SnapshotInsert } from '../infra/asset-snapshot-store.ts';
import {
  alertEventId,
  confirmSnapshotDay,
  writeSnapshotDay,
  type AssetSnapshotAlertQueue,
  type SnapshotReads,
  type SnapshotWriteStore,
  type Transact,
} from './asset-snapshot-write.ts';

const DAY = '2032-06-15';
const BEFORE = '2032-06-15T16:29:59.999Z';
const DEADLINE = '2032-06-15T16:30:00.000Z';
const TRX = { isTransaction: true } as unknown as Transaction<DB>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fixture(now: string, inserted = true) {
  const clock = new FixedClock(now);
  const rows: SnapshotInsert[] = [];
  const store = {
    insertSnapshotIfAbsent: vi.fn((_trx: Transaction<DB>, row: SnapshotInsert) => {
      rows.push({ ...row });
      return Promise.resolve(inserted);
    }),
    insertReceivables: vi
      .fn<SnapshotWriteStore['insertReceivables']>()
      .mockResolvedValue(undefined),
    markComparable: vi.fn<SnapshotWriteStore['markComparable']>().mockResolvedValue(true),
    findSnapshot: vi
      .fn<SnapshotWriteStore['findSnapshot']>()
      .mockResolvedValue({ id: 'winner', waiting_comparable: true }),
  };
  const enqueue = vi
    .fn<AssetSnapshotAlertQueue['enqueue']>()
    .mockResolvedValue({ duplicate: false });
  const reads: SnapshotReads = {
    balances: { total_available_positive_fen: 5n, total_negative_fen: 1n, total_frozen_fen: 2n },
    receivables: [
      { platform: 'jd', union_receivable_fen: 70n },
      { platform: 'taobao', union_receivable_fen: 60n },
    ],
    totalWaitingFen: 3n,
    totalEstimatedFen: 4n,
    readAt: clock.now(),
  };
  const context = { store, clock, alertQueue: { enqueue }, newId: () => 'snap-1' };
  return { clock, rows, store, enqueue, reads, context };
}

it('[AC-B2-04w-UNIT#4] 读完仍在 00:30 前：先写不可比、不更新、不报超时（等提交后确认）', async () => {
  const { rows, store, enqueue, reads, context } = fixture(BEFORE);
  const outcome = await writeSnapshotDay(TRX, context, {
    appId: 'app-a',
    day: DAY,
    reads,
    threshold: null,
  });
  expect(rows[0]?.waiting_comparable).toBe(false);
  expect(store.markComparable).not.toHaveBeenCalled();
  expect(outcome).toEqual({
    snapshotId: 'snap-1',
    inserted: true,
    waitingComparable: false,
    late: false,
    alerts: [],
  });
  expect(enqueue).not.toHaveBeenCalled();
});

it('[AC-B2-04w-UNIT#5] 00:30 前写入：不报超时；垫资告警在同事务入队', async () => {
  const { store, enqueue, reads, context } = fixture(BEFORE);
  const outcome = await writeSnapshotDay(TRX, context, {
    appId: 'app-a',
    day: DAY,
    reads,
    threshold: 129n,
  });
  expect(store.markComparable).not.toHaveBeenCalled();
  expect(outcome).toMatchObject({ waitingComparable: false, late: false });
  expect(outcome.alerts.map((a) => a.kind)).toEqual(['ledger_advance_exposure']);
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(enqueue.mock.calls[0]?.[1]).toMatchObject({
    kind: 'ledger_advance_exposure',
    payload: { union_receivable_fen: '130', advance_alert_fen: '129' },
  });
  expect(store.insertReceivables).toHaveBeenCalledWith(TRX, 'app-a', 'snap-1', reads.receivables);
});

it('[AC-B2-04w-UNIT#6] 读完已超时：首写即不可比，不再更新，入队超时告警', async () => {
  const { rows, store, enqueue, reads, context } = fixture(DEADLINE);
  const outcome = await writeSnapshotDay(TRX, context, {
    appId: 'app-a',
    day: DAY,
    reads,
    threshold: 130n,
  });
  expect(rows[0]?.waiting_comparable).toBe(false);
  expect(store.markComparable).not.toHaveBeenCalled();
  expect(outcome).toMatchObject({ waitingComparable: false, late: true });
  expect(outcome.alerts.map((a) => a.kind)).toEqual(['asset_snapshot_timeout']);
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(enqueue.mock.calls[0]?.[1]).toMatchObject({
    kind: 'asset_snapshot_timeout',
    payload: { app_id: 'app-a', accounting_date: DAY, waiting_comparable: false },
  });
});

it('[AC-B2-04w-UNIT#7] 并发落败者不写子表、不入队、不告警，返回胜者', async () => {
  const { store, enqueue, reads, context } = fixture(DEADLINE, false);
  const outcome = await writeSnapshotDay(TRX, context, {
    appId: 'app-a',
    day: DAY,
    reads,
    threshold: 0n,
  });
  expect(outcome).toEqual({
    snapshotId: 'winner',
    inserted: false,
    waitingComparable: true,
    late: true,
    alerts: [],
  });
  expect(store.insertReceivables).not.toHaveBeenCalled();
  expect(store.markComparable).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
});

it('[AC-B2-04w-UNIT#8] 告警幂等键 (app_id, 会计日, 类型) 决定确定的事件 ID', async () => {
  const first = fixture(DEADLINE);
  const second = fixture(DEADLINE);
  const input = { appId: 'app-a', day: DAY, reads: first.reads, threshold: 0n };
  const a = await writeSnapshotDay(TRX, first.context, input);
  const b = await writeSnapshotDay(TRX, second.context, { ...input, reads: second.reads });
  expect(a.alerts.map((x) => x.eventId)).toEqual(b.alerts.map((x) => x.eventId));
  const ids = new Set([
    ...a.alerts.map((x) => x.eventId),
    alertEventId(JSON.stringify(['app-b', DAY, 'asset_snapshot_timeout'])),
    alertEventId(JSON.stringify(['app-a', '2032-06-16', 'asset_snapshot_timeout'])),
  ]);
  expect(ids.size).toBe(4);
  for (const id of ids) expect(id).toMatch(UUID);
});

/** A pass-through transaction that records how often a new transaction was opened. */
function transaction() {
  const opened = vi.fn();
  const transact: Transact = (work) => {
    opened();
    return work(TRX);
  };
  return { opened, transact };
}

const DAY_ROW = { appId: 'app-a', day: DAY, snapshotId: 'snap-1' };

it('[AC-B2-04w-UNIT#9] 提交后确认仍在 00:30 前：另起事务改为可比，不告警', async () => {
  const { clock, store, enqueue, context } = fixture(BEFORE);
  const { opened, transact } = transaction();
  const outcome = await confirmSnapshotDay(transact, context, DAY_ROW);
  expect(opened).toHaveBeenCalledTimes(1);
  expect(store.markComparable).toHaveBeenCalledWith(TRX, 'app-a', 'snap-1', clock.now());
  expect(outcome).toEqual({ confirmed: true, alerts: [] });
  expect(enqueue).not.toHaveBeenCalled();
});

it('[AC-B2-04w-UNIT#10] 确认时已到 00:30：保持不可比，按日键入队并返回超时告警', async () => {
  const { clock, store, enqueue, context } = fixture(BEFORE);
  // The write transaction's COMMIT returns only at the deadline.
  clock.set(DEADLINE);
  const { opened, transact } = transaction();
  const outcome = await confirmSnapshotDay(transact, context, DAY_ROW);
  expect(opened).toHaveBeenCalledTimes(1);
  expect(store.markComparable).not.toHaveBeenCalled();
  expect(outcome.confirmed).toBe(false);
  expect(outcome.alerts.map((a) => a.kind)).toEqual(['asset_snapshot_timeout']);
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(enqueue.mock.calls[0]?.[0]).toBe(TRX);
  expect(enqueue.mock.calls[0]?.[1]).toMatchObject({
    kind: 'asset_snapshot_timeout',
    appId: 'app-a',
    accountingDate: DAY,
    eventId: alertEventId(JSON.stringify(['app-a', DAY, 'asset_snapshot_timeout'])),
    payload: { app_id: 'app-a', accounting_date: DAY, waiting_comparable: false },
  });
});

it('[AC-B2-04w-UNIT#11] 确认失败：原错误原样抛出，不告警、不吞错', async () => {
  const { store, enqueue, context } = fixture(BEFORE);
  const failure = new Error('confirmation failed');
  store.markComparable.mockRejectedValue(failure);
  await expect(confirmSnapshotDay(transaction().transact, context, DAY_ROW)).rejects.toBe(failure);
  expect(store.markComparable).toHaveBeenCalledTimes(1);
  expect(enqueue).not.toHaveBeenCalled();
});

it('[AC-B2-04w-UNIT#12] 无告警队列：超时告警只返回供记日志，仍不改行', async () => {
  const { store, context } = fixture(DEADLINE);
  const { alertQueue: _queue, ...withoutQueue } = context;
  void _queue;
  const outcome = await confirmSnapshotDay(transaction().transact, withoutQueue, DAY_ROW);
  expect(outcome.confirmed).toBe(false);
  expect(outcome.alerts.map((a) => a.kind)).toEqual(['asset_snapshot_timeout']);
  expect(store.markComparable).not.toHaveBeenCalled();
});
