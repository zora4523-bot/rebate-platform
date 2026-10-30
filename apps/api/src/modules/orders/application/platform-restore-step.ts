// B1-08zc：平台恢复差错单的登记端口（08 BR-FUND-22；04 recon_diffs「写者 ledger，经 ledger 命令登记」）。
// orders 不依赖 ledger（02 §4.1）：这里只声明端口形状，app.module 用 ledger 的 registerReconDiffOnce 实现并经
// OrderUpdateDeps.platformRestore 注入。未注入时不登记，只保留 P9 原有告警。端口与本次同步更新同一事务调用，
// 抛错整事务回滚。
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { PlatformRestoreResolution } from '../domain/platform-restore.ts';

/** 一张 platform_restore 差错单的登记入参；各列取值都由 orders 决定，实现只原样登记（重复登记不覆盖）。 */
export interface PlatformRestoreDiffInput {
  readonly appId: string;
  readonly type: 'platform_restore';
  readonly source: 'R1';
  /** 登记时刻的中国时间月份 YYYY-MM。 */
  readonly period: string;
  readonly refType: 'order';
  /** platformRestoreRefId(order_key, entry_id)。 */
  readonly refId: string;
  /** 平台恢复后的联盟佣金（分）；只作展示。 */
  readonly expectedFen: bigint;
  readonly actualFen: bigint;
  readonly diffFen: bigint;
  /** platformRestoreDedupeKey(order_key, entry_id)。 */
  readonly dedupeKey: string;
  readonly resolution: PlatformRestoreResolution;
}

export interface PlatformRestoreDiffResult {
  /** 只有本次调用插入了这一行时为 true；同键已有（重复同步、并发先提交）为 false。 */
  readonly inserted: boolean;
  /** recon_diffs.id（新插入的或已有的那一行）。 */
  readonly id: string;
}

export interface PlatformRestoreDiffPort {
  register(
    trx: Transaction<DB>,
    input: PlatformRestoreDiffInput,
  ): Promise<PlatformRestoreDiffResult>;
}
