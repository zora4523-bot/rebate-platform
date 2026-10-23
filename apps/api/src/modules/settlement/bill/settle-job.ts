import type { DB } from '@couli/db';
import { transitionSettleJob, type SettleJobEvent, type SettleJobState } from '@couli/domain';
import type { Kysely, Transaction } from 'kysely';
import { newUuidV7 } from '../../platform/index.ts';

// settle_jobs.status 的唯一写者：只经生成的 settle-job transition()（S7；decision 46）。
// 入库首态 START → running；COMPLETE → done；FAIL → failed；同一行重跑 RETRY failed → running。
// 每次写状态都按旧状态做 CAS（WHERE status = <from>）；表外迁移抛 IllegalTransition。

export interface SettleJobKey {
  readonly appId: string;
  readonly job: string;
  readonly platform: string;
  readonly runAt: Date;
}

export class IllegalTransitionError extends Error {
  override readonly name = 'IllegalTransition' as const;
}

function isState(value: string): value is SettleJobState {
  return value === 'running' || value === 'done' || value === 'failed';
}

/** 表内迁移的目标状态；表外（含未知旧状态）一律 IllegalTransition。 */
export function settleJobStep(from: string | null, event: SettleJobEvent): SettleJobState {
  if (from !== null && !isState(from)) {
    throw new IllegalTransitionError(`unknown settle job status ${JSON.stringify(from)}`);
  }
  const result = transitionSettleJob(from, event);
  if (!result.ok || result.noop) {
    throw new IllegalTransitionError(`settle job ${String(from)} --${event}--> not allowed`);
  }
  return result.to;
}

async function insertRunning(
  trx: Transaction<DB>,
  key: SettleJobKey,
  now: Date,
): Promise<string | null> {
  const status = settleJobStep(null, 'START');
  const inserted = await trx
    .withSchema('app')
    .insertInto('settle_jobs')
    .values({
      id: newUuidV7(now),
      app_id: key.appId,
      job: key.job,
      platform: key.platform,
      run_at: key.runAt,
      status,
      processed_count: 0,
      skipped_count: 0,
      started_at: now,
      finished_at: null,
    })
    .onConflict((oc) => oc.columns(['app_id', 'job', 'platform', 'run_at']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return inserted?.id ?? null;
}

async function lockExisting(
  trx: Transaction<DB>,
  key: SettleJobKey,
): Promise<{ id: string; status: string }> {
  return trx
    .withSchema('app')
    .selectFrom('settle_jobs')
    .select(['id', 'status'])
    .where('app_id', '=', key.appId)
    .where('job', '=', key.job)
    .where('platform', '=', key.platform)
    .where('run_at', '=', key.runAt)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

async function casStatus(
  trx: Transaction<DB>,
  jobId: string,
  from: SettleJobState,
  event: SettleJobEvent,
  // 只含迁移 0066 授权 couli_app 可 UPDATE 的列（status、row_version 在下面补）；
  // started_at 不在授权列内，重跑保留首次启动时间。
  set: {
    readonly finished_at: Date | null;
    readonly processed_count?: number;
    readonly skipped_count?: number;
  },
): Promise<void> {
  const to = settleJobStep(from, event);
  const result = await trx
    .withSchema('app')
    .updateTable('settle_jobs')
    .set((eb) => ({ ...set, status: to, row_version: eb('row_version', '+', 1) }))
    .where('id', '=', jobId)
    .where('status', '=', from)
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) {
    throw new IllegalTransitionError(`settle job ${jobId} is no longer ${from} (${event})`);
  }
}

/**
 * 认领一次运行：新键插入 running；已有 failed 行经 RETRY 在同一行重跑（started_at 不变）；
 * 已有 done / running 行判为重放，返回 null、不改行。
 * 唯一约束兜底：并发同键投递在 INSERT 处等先到者提交或回滚。
 */
export async function claimSettleJob(
  trx: Transaction<DB>,
  key: SettleJobKey,
  now: Date,
): Promise<string | null> {
  const inserted = await insertRunning(trx, key, now);
  if (inserted !== null) return inserted;
  const existing = await lockExisting(trx, key);
  if (existing.status !== 'failed') return null;
  // started_at 保留首次启动时间（不在 couli_app 的 UPDATE 授权列内）。
  await casStatus(trx, existing.id, 'failed', 'RETRY', {
    finished_at: null,
    processed_count: 0,
    skipped_count: 0,
  });
  return existing.id;
}

/** 运行完成：running → done（COMPLETE）。 */
export async function completeSettleJob(
  trx: Transaction<DB>,
  jobId: string,
  now: Date,
  processed: number,
  skipped: number,
): Promise<void> {
  await casStatus(trx, jobId, 'running', 'COMPLETE', {
    finished_at: now,
    processed_count: processed,
    skipped_count: skipped,
  });
}

/**
 * 运行失败（生成事务已回滚）：另起事务把该键记为 failed。
 * 回滚后行可能不存在（本次是首投递）或仍是 failed（RETRY 随事务回滚）：
 * 不存在则先 START 再 FAIL；已是 failed / done（并发的另一投递已完成）则不改。
 */
export async function failSettleJob(db: Kysely<DB>, key: SettleJobKey, now: Date): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await insertRunning(trx, key, now);
    const existing = await lockExisting(trx, key);
    if (existing.status !== 'running') return;
    await casStatus(trx, existing.id, 'running', 'FAIL', { finished_at: now });
  });
}
