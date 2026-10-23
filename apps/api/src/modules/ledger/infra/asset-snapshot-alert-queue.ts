// Durable AssetSnapshotAlertQueue over the platform event bus (B2-04wa; BR-FUND-18, BR-FUND-20;
// 规划/02 §11 asset_snapshot.timed_out and union_receivable.exposure_exceeded, D10-188 ①).
// Contract (rule tests in test/spec/ledger/asset-snapshot-alerts/**):
//
// createAssetSnapshotAlertQueue(eventBus)
//   - eventBus is the entry's EVENT_BUS: an object with a function `publish`. Anything else
//     (missing, null, no publish) throws LedgerError('INVALID_INPUT') synchronously, so the
//     assembly refuses to start. Creating it runs nothing (no publish, no clock read).
//
// enqueue(trx, alert)
//   - Publishes exactly one event on `trx` (the snapshot's write or confirm transaction, so the
//     event_log row and the subscribers' jobs commit or roll back with it), with
//     appId = alert.appId, eventId = alert.eventId (derived from (app_id, accounting date, type):
//     the same day and type always gets the same id), version 1, and:
//       asset_snapshot_timeout  → name 'asset_snapshot.timed_out', payload exactly
//         { app_id, accounting_date, type: 'asset_snapshot_timeout', waiting_comparable: false }
//       ledger_advance_exposure → name 'union_receivable.exposure_exceeded', payload exactly
//         { app_id, accounting_date, type: 'ledger_advance_exposure', sum_fen, threshold_fen }
//         where sum_fen / threshold_fen are JSON integers of fen (ADR-0001 §4.2 第 3 项).
//   - No other payload key (no step, no personal data): a replay of the same day and type
//     publishes the same content, so the bus resolves it as a duplicate, never event_conflict.
//   - Resolves { duplicate } of the bus result; a rejection of the bus propagates unchanged.
import type { EventBus } from '../../platform/index.ts';
import type { AssetSnapshotAlertQueue } from '../application/asset-snapshot-write.ts';

export function createAssetSnapshotAlertQueue(eventBus: EventBus): AssetSnapshotAlertQueue {
  void eventBus;
  throw new Error('NotImplemented: createAssetSnapshotAlertQueue');
}
