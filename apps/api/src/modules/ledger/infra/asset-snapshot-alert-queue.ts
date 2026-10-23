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
import { fenToJsonNumber, parseFen } from '@couli/money';
import type { EventBus } from '../../platform/index.ts';
import type {
  AssetSnapshotAlert,
  AssetSnapshotAlertQueue,
} from '../application/asset-snapshot-write.ts';
import { LedgerError } from '../application/errors.ts';

/** The two event names of 规划/02 §11 (D10-188), registered in platform/events EVENT_NAMES. */
const EVENT_NAME = {
  asset_snapshot_timeout: 'asset_snapshot.timed_out',
  ledger_advance_exposure: 'union_receivable.exposure_exceeded',
} as const;

export function createAssetSnapshotAlertQueue(eventBus: EventBus): AssetSnapshotAlertQueue {
  if (
    typeof eventBus !== 'object' ||
    eventBus === null ||
    typeof (eventBus as { publish?: unknown }).publish !== 'function'
  ) {
    throw new LedgerError('INVALID_INPUT', 'the asset snapshot alerts need the EVENT_BUS');
  }
  return {
    async enqueue(trx, alert) {
      const result = await eventBus.publish(trx, {
        appId: alert.appId,
        name: EVENT_NAME[alert.kind],
        payload: eventPayload(alert),
        version: 1,
        eventId: alert.eventId,
      });
      return { duplicate: result.duplicate };
    },
  };
}

/**
 * The 02 §11 payload: only the day's key and the kind's own fields, never the log-only `step`, so
 * a replay of the day and kind publishes the same content (a duplicate, not event_conflict).
 */
function eventPayload(alert: AssetSnapshotAlert) {
  const key = {
    app_id: alert.appId,
    accounting_date: alert.accountingDate,
    type: alert.kind,
  };
  if (alert.kind === 'asset_snapshot_timeout') return { ...key, waiting_comparable: false };
  return {
    ...key,
    // Integer fen in JSON; beyond the safe range it throws InvalidAmount, never rounds.
    sum_fen: fenToJsonNumber(parseFen(alert.payload['union_receivable_fen'])),
    threshold_fen: fenToJsonNumber(parseFen(alert.payload['advance_alert_fen'])),
  };
}
