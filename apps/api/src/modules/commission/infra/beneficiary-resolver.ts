// B2-03p: real SnapshotBeneficiaryResolver (BR-CALC-12 / BR-CALC-13). Reads only through the two
// injected ports — growth's GrowthHistory (levelAt / parentAt replay of level_change_logs and
// relation_change_logs at paidAt) and identity's UserDeletionStatusReader — always on the caller's
// transaction, so uncommitted writes are visible. No growth / identity table is queried here.
//
// owner = the order's attributed user; direct = parentAt(owner, paidAt); indirect =
// parentAt(direct, paidAt) (no direct → no indirect, never shifted up). Each level = levelAt(that
// user, paidAt); a missing level log answers L1 and growth's warning is kept in `warnings`.
// Deletion status is read once for all present beneficiaries: not found, processing or done →
// forfeited with reason `deleted` (contracts/enums/fund.yaml forfeit_reason); cooling and any
// risk_state (banned / frozen / appealing) stay active at snapshot time.
import type { ForfeitReason } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { GrowthHistory } from '../../growth/index.ts';
import type { UserDeletionStatus, UserDeletionStatusReader } from '../../identity/index.ts';
import type {
  SnapshotBeneficiaries,
  SnapshotBeneficiary,
  SnapshotBeneficiaryResolver,
} from '../application/snapshot.ts';

export interface SnapshotBeneficiaryResolverOptions {
  readonly growth: GrowthHistory;
  readonly deletion: UserDeletionStatusReader;
}

type Warning = SnapshotBeneficiaries['warnings'][number];

const DELETED: ForfeitReason = 'deleted';

function toBeneficiary(
  userId: string,
  level: SnapshotBeneficiary['level'],
  status: UserDeletionStatus | undefined,
): SnapshotBeneficiary {
  // BR-CALC-13: absent from app.users for this app, or deletion processing / done → forfeited.
  const forfeited = status === undefined || status === 'processing' || status === 'done';
  return {
    userId,
    level,
    status: forfeited ? 'forfeited' : 'active',
    forfeitReason: forfeited ? DELETED : null,
  };
}

export function createSnapshotBeneficiaryResolver(
  options: SnapshotBeneficiaryResolverOptions,
): SnapshotBeneficiaryResolver {
  const { growth, deletion } = options;

  async function levelOf(
    trx: Transaction<DB>,
    appId: string,
    userId: string,
    at: Date,
    warnings: Warning[],
  ): Promise<SnapshotBeneficiary['level']> {
    const found = await growth.levelAt(trx, { app_id: appId, user_id: userId, at });
    if (found.missing) warnings.push({ code: 'growth_level_log_missing', userId });
    return found.level;
  }

  return {
    async resolve(trx, input) {
      const { appId, ownerUserId, paidAt } = input;
      const warnings: Warning[] = [];

      const directId = await growth.parentAt(trx, {
        app_id: appId,
        user_id: ownerUserId,
        at: paidAt,
      });
      const indirectId =
        directId === null
          ? null
          : await growth.parentAt(trx, { app_id: appId, user_id: directId, at: paidAt });

      const ownerLevel = await levelOf(trx, appId, ownerUserId, paidAt, warnings);
      const directLevel =
        directId === null ? null : await levelOf(trx, appId, directId, paidAt, warnings);
      const indirectLevel =
        indirectId === null ? null : await levelOf(trx, appId, indirectId, paidAt, warnings);

      const ids = [ownerUserId];
      if (directId !== null) ids.push(directId);
      if (indirectId !== null) ids.push(indirectId);
      const statuses = await deletion.read(trx, { app_id: appId, user_ids: ids });

      return {
        owner: toBeneficiary(ownerUserId, ownerLevel, statuses.get(ownerUserId)),
        direct:
          directId === null || directLevel === null
            ? null
            : toBeneficiary(directId, directLevel, statuses.get(directId)),
        indirect:
          indirectId === null || indirectLevel === null
            ? null
            : toBeneficiary(indirectId, indirectLevel, statuses.get(indirectId)),
        warnings,
      };
    },
  };
}
