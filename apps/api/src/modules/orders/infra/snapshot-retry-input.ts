import type { DB } from '@couli/db';
import type { Selectable, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { CommissionSnapshotPlan } from '../domain/commission-snapshot.ts';

/** 扫描只从持久化订单与状态历史恢复输入，不从夹具或当前报文恢复。
 * 拼多多缺服务费、platform_modified 缺首次迁移报文时返回 skip，由扫描器记 warn。
 */
export async function readSnapshotRetryInput(
  trx: Transaction<DB>,
  order: Selectable<DB['orders']>,
  clock: Clock,
): Promise<CommissionSnapshotPlan> {
  void trx;
  void order;
  void clock;
  throw new Error('NotImplemented: readSnapshotRetryInput');
}
