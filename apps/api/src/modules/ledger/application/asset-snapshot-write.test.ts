import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { SnapshotInsert } from '../infra/asset-snapshot-store.ts';
import {
  alertEventId,
  writeSnapshotDay,
  type AssetSnapshotAlertQueue,
  type SnapshotReads,
  type SnapshotWriteStore,
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
    markNotComparable: vi
      .fn<SnapshotWriteStore['markNotComparable']>()
      .mockResolvedValue(undefined),
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

it('[AC-B2-04w-UNIT#4] 取预估后、写入期间跨过 00:30：同事务标不可比并入队超时告警', async () => {
  const { clock, rows, store, enqueue, reads, context } = fixture(BEFORE);
  store.insertReceivables.mockImplementation(() => {
    clock.set(DEADLINE);
    return Promise.resolve();
  });
  const outcome = await writeSnapshotDay(TRX, context, {
    appId: 'app-a',
    day: DAY,
    reads,
    threshold: null,
  });
  expect(rows[0]?.waiting_comparable).toBe(true);
  expect(store.markNotComparable).toHaveBeenCalledWith(TRX, 'app-a', 'snap-1', clock.now());
  expect(outcome).toMatchObject({ snapshotId: 'snap-1', inserted: true, waitingComparable: false });
  expect(outcome.alerts.map((a) => a.kind)).toEqual(['asset_snapshot_timeout']);
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(enqueue.mock.calls[0]?.[0]).toBe(TRX);
  expect(enqueue.mock.calls[0]?.[1]).toMatchObject({
    kind: 'asset_snapshot_timeout',
    appId: 'app-a',
    accountingDate: DAY,
    payload: { app_id: 'app-a', accounting_date: DAY, waiting_comparable: false },
  });
});

it('[AC-B2-04w-UNIT#5] 写完仍在 00:30 前：可比、不报超时；垫资告警在同事务入队', async () => {
  const { store, enqueue, reads, context } = fixture(BEFORE);
  const outcome = await writeSnapshotDay(TRX, context, {
    appId: 'app-a',
    day: DAY,
    reads,
    threshold: 129n,
  });
  expect(store.markNotComparable).not.toHaveBeenCalled();
  expect(outcome.waitingComparable).toBe(true);
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
  expect(store.markNotComparable).not.toHaveBeenCalled();
  expect(outcome.alerts.map((a) => a.kind)).toEqual(['asset_snapshot_timeout']);
  expect(enqueue).toHaveBeenCalledTimes(1);
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
    alerts: [],
  });
  expect(store.insertReceivables).not.toHaveBeenCalled();
  expect(store.markNotComparable).not.toHaveBeenCalled();
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
