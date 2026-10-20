// B2-04i: read-only port over the commission snapshot of one sub-order (BR-CALC-02/10/13),
// answered inside the caller's transaction.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import {
  assertCommissionVersion,
  assertCurrentVersion,
  parseSnapshotBeneficiaries,
  parseSnapshotRole,
  type ReadSnapshotBeneficiary,
  type SnapshotForfeitedEvent,
} from '../domain/snapshot-read.ts';
import {
  selectForfeitedEvents,
  selectMaxVersions,
  selectSplit,
  selectVersionBase,
} from '../infra/snapshot-reader.ts';

export type { ReadSnapshotBeneficiary, SnapshotForfeitedEvent } from '../domain/snapshot-read.ts';

export interface ReadCommissionSnapshotInput {
  readonly appId: string;
  readonly orderId: string;
  /** 调用方期望的 commission_version，须等于本子订单最大版本；本模块不读取 orders。 */
  readonly commissionVersion: number;
}

export interface ReadCommissionSnapshotResult {
  readonly appId: string;
  readonly orderId: string;
  readonly ruleVersionId: string;
  readonly commissionVersion: number;
  /** 本子订单最大版本的 B，来自 commission_split_totals，不是首次快照的 B。 */
  readonly baseFen: bigint;
  readonly reserveBp: number;
  readonly beneficiaries: readonly ReadSnapshotBeneficiary[];
  /** 本 app、本子订单的所有 forfeited 事件，按 event_seq 升序；不受金额版本过滤。 */
  readonly forfeitedEvents: readonly SnapshotForfeitedEvent[];
}

/**
 * BR-CALC-02/10/13：仅在传入事务中 SELECT，不创建连接、事务、快照或事件。
 * 比例与身份保留不可变快照值，不重新查询现行规则或用户状态。
 * 无快照返回 null；快照存在而金额版本缺失或期望版本不等于最大版本则抛错。
 * 调用方负责订单锁及当前版本的一致性；此端口不接管事务的提交或回滚。
 */
export async function readCommissionSnapshot(
  trx: Transaction<DB>,
  input: ReadCommissionSnapshotInput,
): Promise<ReadCommissionSnapshotResult | null> {
  assertCommissionVersion(input.commissionVersion);
  const { appId, orderId } = input;
  const split = await selectSplit(trx, appId, orderId);
  if (split === undefined) return null;
  const beneficiaries = parseSnapshotBeneficiaries(split.beneficiaries);
  const max = await selectMaxVersions(trx, appId, orderId);
  const version = assertCurrentVersion(input.commissionVersion, max.totals, max.amounts);
  const base = await selectVersionBase(trx, appId, orderId, version);
  const baseFen = base.totalsBase;
  if (baseFen === undefined) {
    throw new Error(`commission: snapshot version ${String(version)} has no totals row`);
  }
  // One B per version (BR-CALC-02): every amount row of the version carries the totals' B.
  if (base.amountBases.length === 0 || base.amountBases.some((b) => b !== baseFen)) {
    throw new Error(`commission: snapshot version ${String(version)} amount rows disagree on B`);
  }
  const events = await selectForfeitedEvents(trx, appId, orderId);
  return {
    appId,
    orderId,
    ruleVersionId: split.ruleVersionId,
    commissionVersion: version,
    baseFen,
    reserveBp: split.reserveBp,
    beneficiaries,
    forfeitedEvents: events.map((e): SnapshotForfeitedEvent => ({
      eventSeq: e.eventSeq,
      userId: e.userId,
      role: parseSnapshotRole(e.role, `event ${String(e.eventSeq)}`),
      reason: e.reason,
    })),
  };
}
