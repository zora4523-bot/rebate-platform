// B1-08zc：平台恢复差错单的登记端口（08 BR-FUND-22；04 recon_diffs「写者 ledger，经 ledger 命令登记」）。
// orders 不依赖 ledger（02 §4.1）：这里只声明端口形状，app.module 用 ledger 的 registerReconDiffOnce 实现并经
// OrderUpdateDeps.platformRestore 注入。未注入时不登记，只保留 P9 原有告警。端口与本次同步更新同一事务调用，
// 抛错整事务回滚。
import type { DB } from '@couli/db';
import { chinaMonth, orderKey } from '@couli/domain';
import type { Transaction } from 'kysely';
import {
  detectPlatformRestore,
  isPlatformRestoreEligible,
  isRestorableRebate,
  platformRestoreDedupeKey,
  platformRestoreRefId,
  type PlatformRestoreChange,
  type PlatformRestoreResolution,
  type PlatformRestoreTrigger,
} from '../domain/platform-restore.ts';
import { readRebateEntry } from '../infra/platform-restore-store.ts';

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

/** 本次更新的订单（锁内读到的库内行，返利状态与原因未被本模块改动）与平台、佣金的前后值。 */
export interface PlatformRestoreCheck extends PlatformRestoreChange {
  readonly app_id: string;
  readonly order_id: string;
  readonly platform: string;
  readonly sub_order_id: string;
  readonly rebate_status: string;
  readonly reason: string | null;
  readonly now: Date;
}

export type PlatformRestoreOutcome =
  | { readonly kind: 'none' }
  /** 前提与触发都成立，但没有进入当前返利状态的历史行：无法构造键，不登记（写后另打告警）。 */
  | { readonly kind: 'entry_missing'; readonly trigger: PlatformRestoreTrigger }
  | {
      readonly kind: 'registered';
      /** 本次调用插入了新单（只有这时才打 platform_restore 告警）。 */
      readonly inserted: boolean;
      readonly reconDiffId: string;
      readonly trigger: PlatformRestoreTrigger;
      readonly reasonCode: string | null;
      readonly rebateStatus: string;
    };

const NONE: PlatformRestoreOutcome = { kind: 'none' };

/**
 * 在本次 CAS 写入之后、同一事务内判定并登记（编排 9.2 第 2～5 条）。判定先看触发（纯计算），触发成立且返利状态
 * 为 VOID / CLAWED_BACK 时才读进入行；端口抛错不吞，整事务回滚。不写 rebate_status、不写分录。
 */
export async function runPlatformRestore(
  trx: Transaction<DB>,
  port: PlatformRestoreDiffPort,
  check: PlatformRestoreCheck,
): Promise<PlatformRestoreOutcome> {
  const signal = detectPlatformRestore(check);
  if (signal === null || !isRestorableRebate(check.rebate_status)) return NONE;
  const entry = await readRebateEntry(trx, check, check.rebate_status);
  const eligible = isPlatformRestoreEligible({
    rebateStatus: check.rebate_status,
    reason: check.reason,
    entryEvent: entry?.event ?? null,
  });
  if (!eligible) return NONE;
  if (entry === undefined) return { kind: 'entry_missing', trigger: signal.trigger };
  const key = orderKey(check.platform, check.sub_order_id);
  const registration = await port.register(trx, {
    appId: check.app_id,
    type: 'platform_restore',
    source: 'R1',
    period: chinaMonth(check.now),
    refType: 'order',
    refId: platformRestoreRefId(key, entry.id),
    expectedFen: signal.expectedFen,
    actualFen: 0n,
    diffFen: signal.expectedFen,
    dedupeKey: platformRestoreDedupeKey(key, entry.id),
    resolution: {
      reason_code: check.reason,
      rebate_status: check.rebate_status,
      trigger: signal.trigger,
      platform_status: check.platformAfter,
    },
  });
  return {
    kind: 'registered',
    inserted: registration.inserted,
    reconDiffId: registration.id,
    trigger: signal.trigger,
    reasonCode: check.reason,
    rebateStatus: check.rebate_status,
  };
}
