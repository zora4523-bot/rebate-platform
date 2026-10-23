import type { DB } from '@couli/db';
import { InvalidAmount } from '@couli/money';
import type { Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import type { EventBus } from '../../platform/index.ts';
import type { AssetSnapshotAlert } from '../application/asset-snapshot-write.ts';
import { LedgerError } from '../application/errors.ts';
import { createAssetSnapshotAlertQueue } from './asset-snapshot-alert-queue.ts';

const TRX = { isTransaction: true } as unknown as Transaction<DB>;
const EVENT_ID = '0b5c3f1e-2a4d-8c6e-9f01-23456789abcd';

function alert(overrides: Partial<AssetSnapshotAlert>): AssetSnapshotAlert {
  return {
    kind: 'asset_snapshot_timeout',
    appId: 'app-a',
    accountingDate: '2032-06-15',
    key: 'k',
    eventId: EVENT_ID,
    payload: {},
    ...overrides,
  };
}

function bus(duplicate = false) {
  const publish = vi.fn<EventBus['publish']>().mockResolvedValue({ eventId: EVENT_ID, duplicate });
  return { publish };
}

it('[AC-B2-04wa-UNIT#4] 超时告警按 02 §11 发 asset_snapshot.timed_out，载荷不带 step', async () => {
  const eventBus = bus(true);
  const queue = createAssetSnapshotAlertQueue(eventBus);
  const result = await queue.enqueue(
    TRX,
    alert({ payload: { step: 'not_confirmed', waiting_comparable: false } }),
  );
  expect(result).toEqual({ duplicate: true });
  expect(eventBus.publish).toHaveBeenCalledWith(TRX, {
    appId: 'app-a',
    name: 'asset_snapshot.timed_out',
    version: 1,
    eventId: EVENT_ID,
    payload: {
      app_id: 'app-a',
      accounting_date: '2032-06-15',
      type: 'asset_snapshot_timeout',
      waiting_comparable: false,
    },
  });
});

it('[AC-B2-04wa-UNIT#5] 垫资告警金额为整数分；超出安全整数即抛 InvalidAmount、不发布', async () => {
  const eventBus = bus();
  const queue = createAssetSnapshotAlertQueue(eventBus);
  await queue.enqueue(
    TRX,
    alert({
      kind: 'ledger_advance_exposure',
      payload: { union_receivable_fen: '130', advance_alert_fen: '129' },
    }),
  );
  expect(eventBus.publish.mock.calls[0]?.[1]).toMatchObject({
    name: 'union_receivable.exposure_exceeded',
    payload: {
      app_id: 'app-a',
      accounting_date: '2032-06-15',
      type: 'ledger_advance_exposure',
      sum_fen: 130,
      threshold_fen: 129,
    },
  });
  await expect(
    queue.enqueue(
      TRX,
      alert({
        kind: 'ledger_advance_exposure',
        payload: { union_receivable_fen: '9007199254740993', advance_alert_fen: '1' },
      }),
    ),
  ).rejects.toBeInstanceOf(InvalidAmount);
  expect(eventBus.publish).toHaveBeenCalledTimes(1);
});

it('[AC-B2-04wa-UNIT#6] 没有可用的 publish 即同步拒绝 INVALID_INPUT', () => {
  for (const bad of [undefined, null, {}, { publish: 1 }]) {
    expect(() => createAssetSnapshotAlertQueue(bad as never)).toThrow(LedgerError);
  }
});
