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
import type { AssetSnapshotDependencies, AssetSnapshotRunner } from './asset-snapshot.ts';

export interface AssetSnapshotAssembly extends Omit<AssetSnapshotDependencies, 'alertQueue'> {
  readonly eventBus: EventBus;
}

export function assembleAssetSnapshot(assembly: AssetSnapshotAssembly): AssetSnapshotRunner {
  void assembly;
  throw new Error('NotImplemented: assembleAssetSnapshot');
}
