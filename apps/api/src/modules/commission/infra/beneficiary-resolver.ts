import type { GrowthHistory } from '../../growth/index.ts';
import type { UserDeletionStatusReader } from '../../identity/index.ts';
import type { SnapshotBeneficiaryResolver } from '../application/snapshot.ts';

export interface SnapshotBeneficiaryResolverOptions {
  readonly growth: GrowthHistory;
  readonly deletion: UserDeletionStatusReader;
}

export function createSnapshotBeneficiaryResolver(
  options: SnapshotBeneficiaryResolverOptions,
): SnapshotBeneficiaryResolver {
  void options;
  throw new Error('NotImplemented: createSnapshotBeneficiaryResolver');
}
