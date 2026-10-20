import type { UserLevel } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { SnapshotRole } from '../domain/snapshot.ts';

export interface ReadCommissionSnapshotInput {
  readonly appId: string;
  readonly orderId: string;
  /** 调用方期望的 commission_version，须等于本子订单最大版本；本模块不读取 orders。 */
  readonly commissionVersion: number;
}

export interface ReadSnapshotBeneficiary {
  readonly userId: string;
  readonly role: SnapshotRole;
  readonly ratioBp: number;
  readonly level: UserLevel;
  readonly initialStatus: 'active' | 'forfeited';
  readonly forfeitReason: string | null;
}

export interface SnapshotForfeitedEvent {
  readonly eventSeq: bigint;
  readonly userId: string;
  readonly role: SnapshotRole;
  readonly reason: string | null;
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
  void trx;
  void input;
  throw new Error('NotImplemented: readCommissionSnapshot');
}
