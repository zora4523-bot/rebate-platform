// Assembly of the asset daily snapshot with its durable alerts (B2-04wa; D10-188 ①): the alert
// port is required here. Contract (rule tests in test/spec/ledger/asset-snapshot-alerts/**):
//
// assembleAssetSnapshot(assembly)
//   - assembly is AssetSnapshotDependencies without alertQueue, plus the entry's EVENT_BUS.
//   - eventBus missing, null or without a function `publish` → throws LedgerError('INVALID_INPUT')
//     synchronously, before anything else: no clock read, no source or threshold read, nothing
//     published. The entry then refuses to start.
//   - Otherwise returns the runner of createAssetSnapshot with
//     alertQueue = createAssetSnapshotAlertQueue(eventBus); creating it runs nothing.
//
// Confirmation of a committed, not yet comparable day (the replay path, money r4 S2): the confirm
// transaction first locks the day's row and reads it again; already comparable → returns with no
// alert; only after the lock is held does it read the Clock and decide comparable vs timed out.
import type { EventBus } from '../../platform/index.ts';
import { createAssetSnapshotAlertQueue } from '../infra/asset-snapshot-alert-queue.ts';
import {
  createAssetSnapshot,
  type AssetSnapshotDependencies,
  type AssetSnapshotRunner,
} from './asset-snapshot.ts';

export interface AssetSnapshotAssembly extends Omit<AssetSnapshotDependencies, 'alertQueue'> {
  readonly eventBus: EventBus;
}

// TODO(规划/11 §4.2): R-03 启动自检把 EVENT_BUS 列入生产必需清单 — blocked on R-03 启动自检尚未落地（platform/events 与 ledger 之外，另开任务）
export function assembleAssetSnapshot(assembly: AssetSnapshotAssembly): AssetSnapshotRunner {
  // Refuses synchronously (LedgerError INVALID_INPUT) before anything else runs.
  const alertQueue = createAssetSnapshotAlertQueue(assembly.eventBus);
  const { eventBus: _eventBus, ...dependencies } = assembly;
  void _eventBus;
  return createAssetSnapshot({ ...dependencies, alertQueue });
}
