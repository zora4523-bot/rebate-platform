import type { DB } from '@couli/db';
import type { ReconDiffType } from '@couli/contracts-ts';
import {
  classifySettlementBillOrder,
  splitSettlementBillBatches,
  transitionSettleBatch,
  type BillValidationResult,
} from '@couli/domain';
import { applyReserve, parseFen, subFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import { newUuidV7 } from '../../../platform/index.ts';
import type {
  BillJobDependencies,
  BillReconDiffInput,
  BillSnapshot,
  BillSnapshotSelection,
  BillSourceSelection,
  BillSourceSettlement,
  BillValidation,
} from '../job.ts';
import {
  claimSettleJob,
  completeSettleJob,
  failSettleJob,
  type SettleJobKey,
} from '../settle-job.ts';

// 补充批次（BR-FUND-04 ⑧⑨⑫）：finance 对同一月结账单发起补充校验与批次，流程同账单日任务
// （逐单校验、差错单经 ledger registerReconDiff、DRAFT 只经 settle-batch transition()、补记项只进
// 其订单平台的批次），kind = supplement，单独确认。step-up、HTTP 与审计归 B2-09。
// 补充批次不是账单生成：不等资产快照（③ 属账单日任务）。

/** 与账单日任务同一组端口（不含资产快照读口）。 */
export type SupplementDependencies = Omit<BillJobDependencies, 'snapshotStatus'>;

export interface SupplementInput {
  readonly appId: string;
  /** 目标月结账单（账单月 YYYY-MM）；范围与差错账期都按它，不按发起时所在月。 */
  readonly billId: string;
  readonly platform: string;
  /**
   * 发起请求的名义时刻，作幂等键：同一 (app, platform, requestedAt) 重放只生成一次
   * （settle_jobs 唯一键）。校验截点取注入的 Clock，不取此值。
   */
  readonly requestedAt: Date;
}

/** credit.enabled.<platform> off → on 后对当期账单（最近一份账单）重校验。 */
export interface RecheckInput {
  readonly appId: string;
  readonly platform: string;
  readonly requestedAt: Date;
}

export interface SupplementResult {
  readonly outcome: 'generated' | 'duplicate';
  readonly billId: string;
  readonly platform: string;
  /** 本轮新生成的补充批次；候选与补记项都为空时为空（SB1 守卫）。重放时为空。 */
  readonly batchIds: readonly string[];
}

export type SupplementRejectReason = 'bill_not_found' | 'bill_not_ready' | 'credit_disabled';

/** 发起前置条件不成立；不写任何表。内部错误，契约码待 B2-09 分配。 */
export interface SupplementRejected extends Error {
  readonly name: 'SupplementRejected';
  readonly reason: SupplementRejectReason;
}

export interface SupplementCommand {
  /** finance 对指定账单、指定平台发起补充校验与批次。 */
  launch(db: Kysely<DB>, input: SupplementInput): Promise<SupplementResult>;
  /** 开关打开后对当期账单重校验并生成补充批次；当期账单 = bill_id 最大的一份账单。 */
  recheckCurrentBill(db: Kysely<DB>, input: RecheckInput): Promise<SupplementResult>;
}

export class SupplementRejectedError extends Error implements SupplementRejected {
  override readonly name = 'SupplementRejected' as const;
  readonly reason: SupplementRejectReason;

  constructor(reason: SupplementRejectReason) {
    super(`settlement supplement rejected: ${reason}`);
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 实现。settle_jobs 只经 ../settle-job.ts（生成的 settle-job transition()，只写 0066 授权列）。
// 任务键沿用 job = 'bill'（settle_jobs_job_check 只允许四个值），run_at = 名义请求时刻。

const JOB = 'bill';
const DEFAULT_MAX_ORDERS = 5000;
/** 一条 INSERT 的明细行数上限，避免超出 PG 参数个数上限。 */
const INSERT_CHUNK = 1000;
const DIFF_SOURCE = 'R1';
const DIFF_REF_TYPE = 'order';

type ItemRole = 'self' | 'share' | 'direct' | 'indirect';

interface ItemRow {
  readonly item_type: 'order' | 'beneficiary';
  readonly order_id: string;
  readonly user_id: string | null;
  readonly role: ItemRole | null;
  readonly beneficiary_credit_id: string | null;
  readonly settle_seq: number;
  readonly b_settle_fen: bigint | null;
}

interface CandidateFacts {
  readonly orderId: string;
  readonly settleSeq: number;
  readonly bSettleFen: bigint;
}

interface CreditedFacts {
  readonly orderKey: string;
  readonly orderId: string;
  readonly settleSeq: number;
}

interface Target {
  readonly billId: string | null;
}

function positiveInteger(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[0-9]+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError(`config ${name} must be a positive integer`);
  }
  return parsed;
}

function parseCounts(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < rows.length; start += size) out.push(rows.slice(start, start + size));
  return out;
}

/** 截至校验截点（含）我方已取得的最大 seq；不以联盟结算时间排序。 */
function chooseSettlement(
  settlements: readonly BillSourceSettlement[],
  cutoffMs: number,
): BillSourceSettlement | null {
  let chosen: BillSourceSettlement | null = null;
  for (const s of settlements) {
    if (s.createdAt.getTime() > cutoffMs) continue;
    if (chosen === null || s.seq > chosen.seq) chosen = s;
  }
  return chosen;
}

/** BR-CALC-02：B = max(0, floor(max(0,N) × (10000 − reserve_bp) / 10000) − tlj_deduct_fen)。 */
function convertBase(commissionFen: bigint, reserveBp: number, tljDeductFen: bigint): bigint {
  const afterReserve = applyReserve(commissionFen, BigInt(reserveBp)).after_reserve_fen;
  return afterReserve > tljDeductFen ? subFen(afterReserve, tljDeductFen) : 0n;
}

function diffInput(
  appId: string,
  billId: string,
  type: ReconDiffType,
  orderKey: string,
  expectedFen: bigint,
  actualFen: bigint,
): BillReconDiffInput {
  return {
    appId,
    type,
    source: DIFF_SOURCE,
    period: billId,
    refType: DIFF_REF_TYPE,
    refId: orderKey,
    expectedFen,
    actualFen,
    diffFen: subFen(actualFen, expectedFen),
    dedupeKey: null,
    resolution: null,
  };
}

function isRejected(error: unknown): boolean {
  return error instanceof SupplementRejectedError;
}

export function createSupplementCommand(dependencies: SupplementDependencies): SupplementCommand {
  const deps = dependencies;

  async function creditEnabled(appId: string, platform: string): Promise<boolean> {
    // credit.enabled.<platform> 默认 off（BR-CALC-03）；只认明确的 on。
    const enabled = await deps.config.get(appId, `credit.enabled.${platform}`);
    return enabled === 'on' || enabled === true;
  }

  async function readSnapshotOrThrow(
    trx: Transaction<DB>,
    selection: BillSnapshotSelection,
  ): Promise<BillSnapshot> {
    const snapshot = await deps.readSnapshot(trx, selection);
    if (snapshot === null) {
      throw new Error(
        `settlement supplement: commission snapshot v${String(selection.commissionVersion)} missing`,
      );
    }
    return snapshot;
  }

  /** 锁住目标账单行（同账单的补充与账单日任务在此串行）；前置条件不成立抛 SupplementRejected。 */
  async function lockBill(
    trx: Transaction<DB>,
    appId: string,
    platform: string,
    target: Target,
  ): Promise<string> {
    let query = trx
      .withSchema('app')
      .selectFrom('settle_bills')
      .select(['bill_id', 'generated_at', 'platform_order_counts'])
      .where('app_id', '=', appId);
    query =
      target.billId === null
        ? query.orderBy('bill_id', 'desc').limit(1)
        : query.where('bill_id', '=', target.billId);
    const bill = await query.forUpdate().executeTakeFirst();
    if (bill === undefined) throw new SupplementRejectedError('bill_not_found');
    // 账单仍在出账中，或该平台的账单日任务还没在本账单上出过结果：不发起补充，避免与首批重叠。
    if (bill.generated_at === null) throw new SupplementRejectedError('bill_not_ready');
    if (!Object.prototype.hasOwnProperty.call(parseCounts(bill.platform_order_counts), platform)) {
      throw new SupplementRejectedError('bill_not_ready');
    }
    return bill.bill_id;
  }

  /** 已在未驳回批次中待执行或已入账的子订单（任意账单），不再重复纳入补充批次。 */
  async function pendingOrderIds(
    trx: Transaction<DB>,
    appId: string,
    orderIds: readonly string[],
  ): Promise<Set<string>> {
    const out = new Set<string>();
    for (const part of chunks(orderIds, INSERT_CHUNK)) {
      const rows = await trx
        .withSchema('app')
        .selectFrom('settle_batch_items as i')
        .innerJoin('settle_batches as b', (join) =>
          join.onRef('b.batch_id', '=', 'i.batch_id').onRef('b.app_id', '=', 'i.app_id'),
        )
        .select('i.order_id')
        .where('i.app_id', '=', appId)
        .where('i.item_type', '=', 'order')
        .where('b.status', '<>', 'CANCELLED')
        .where((eb) => eb.or([eb('i.result', 'is', null), eb('i.result', '=', 'credited')]))
        .where('i.order_id', 'in', part)
        .execute();
      for (const r of rows) out.add(r.order_id);
    }
    return out;
  }

  async function generate(
    trx: Transaction<DB>,
    appId: string,
    platform: string,
    requestedAt: Date,
    target: Target,
    now: Date,
  ): Promise<SupplementResult> {
    if (!(await creditEnabled(appId, platform))) {
      throw new SupplementRejectedError('credit_disabled');
    }
    const billId = await lockBill(trx, appId, platform, target);

    const key: SettleJobKey = { appId, job: JOB, platform, runAt: requestedAt };
    // 新键 START；同键 failed 行 RETRY 同一行重跑；done / running 判为重放、不改行。
    const jobId = await claimSettleJob(trx, key, now);
    if (jobId === null) return { outcome: 'duplicate', billId, platform, batchIds: [] };

    const rawTolerance = await deps.config.get(appId, 'settle.batch.match_tolerance_fen');
    const toleranceFen =
      rawTolerance === undefined || rawTolerance === null ? 0n : parseFen(rawTolerance);
    if (toleranceFen < 0n) {
      throw new RangeError('config settle.batch.match_tolerance_fen must be non-negative');
    }
    const maxOrders =
      positiveInteger(
        await deps.config.get(appId, 'settle.batch.max_orders'),
        'settle.batch.max_orders',
      ) ?? DEFAULT_MAX_ORDERS;

    const selection: BillSourceSelection = {
      appId,
      platform,
      runAt: requestedAt,
      billId,
      generationStartedAt: now,
    };
    const rows = await deps.readSource(trx, selection);
    const cutoffMs = now.getTime();

    const validations: BillValidation[] = [];
    const candidates = new Map<string, CandidateFacts>();
    const credited: CreditedFacts[] = [];
    let heldCount = 0;

    for (const row of rows) {
      const chosen = chooseSettlement(row.settlements, cutoffMs);
      const order = row.order;
      const facts = (snapshots: readonly { commission_version: number; base_fen: bigint }[]) =>
        order === null
          ? null
          : {
              rebate_status: order.rebateStatus,
              settle_period: order.settlePeriod,
              hold: order.hold,
              rights_pending: order.rightsPending,
              snapshots,
              union_authoritative: order.unionAuthoritative,
            };
      // 先不读快照判范围与类别（占位快照只用来区分「需要比金额」），再按需读当前版本快照复核。
      const preliminary = classifySettlementBillOrder({
        bill_period: billId,
        generation_started_at: now,
        order:
          order === null
            ? null
            : {
                ...facts([{ commission_version: 0, base_fen: 0n }])!,
                union_authoritative: true,
              },
        settlement:
          chosen === null
            ? null
            : {
                source: chosen.source,
                created_at: chosen.createdAt,
                settle_commission_fen: chosen.commissionFen,
                b_settle_fen: 0n,
              },
        match_tolerance_fen: toleranceFen,
      });
      if (preliminary === null) continue;

      let result: BillValidationResult = preliminary;
      if (order !== null && preliminary === 'candidate' && chosen !== null) {
        const snapshotSelection = {
          appId,
          orderId: order.orderId,
          commissionVersion: order.commissionVersion,
        };
        const snapshot = await readSnapshotOrThrow(trx, snapshotSelection);
        const tlj = await deps.readTljDeductFen(trx, snapshotSelection);
        const bSettle = convertBase(chosen.commissionFen, snapshot.reserveBp, tlj);
        const final = classifySettlementBillOrder({
          bill_period: billId,
          generation_started_at: now,
          order: facts([
            { commission_version: order.commissionVersion, base_fen: snapshot.baseFen },
          ]),
          settlement: {
            source: chosen.source,
            created_at: chosen.createdAt,
            settle_commission_fen: chosen.commissionFen,
            b_settle_fen: bSettle,
          },
          match_tolerance_fen: toleranceFen,
        });
        if (final === null) throw new Error('settlement supplement: classification changed scope');
        result = final;
        if (result === 'candidate') {
          candidates.set(row.orderKey, {
            orderId: order.orderId,
            settleSeq: chosen.seq,
            bSettleFen: bSettle,
          });
        } else {
          // 同账单同单同类型的差错由 registerReconDiff 的业务键去重，不重复登记。
          await deps.registerDiff(
            trx,
            diffInput(
              appId,
              billId,
              'settle_amount_mismatch',
              row.orderKey,
              snapshot.baseFen,
              bSettle,
            ),
            { clock: deps.clock },
          );
        }
      } else if (preliminary === 'missing_settlement' && order !== null) {
        const snapshot = await deps.readSnapshot(trx, {
          appId,
          orderId: order.orderId,
          commissionVersion: order.commissionVersion,
        });
        await deps.registerDiff(
          trx,
          diffInput(appId, billId, 'settle_missing', row.orderKey, snapshot?.baseFen ?? 0n, 0n),
          { clock: deps.clock },
        );
      } else if (preliminary === 'unexpected_settlement' && chosen !== null) {
        // BR-FUND-09：联盟有结算而我方 ESTIMATED / VOID / CLAWED_BACK 或无单，登记联盟差错。
        await deps.registerDiff(
          trx,
          diffInput(appId, billId, 'union_mismatch', row.orderKey, 0n, chosen.commissionFen),
          { clock: deps.clock },
        );
      } else if (preliminary === 'deferred') {
        heldCount += 1;
      } else if (preliminary === 'already_credited' && order !== null && chosen !== null) {
        credited.push({ orderKey: row.orderKey, orderId: order.orderId, settleSeq: chosen.seq });
      }

      validations.push({
        orderKey: row.orderKey,
        orderId: order === null ? null : order.orderId,
        result,
        settleSeq: chosen === null ? null : chosen.seq,
      });
    }

    await deps.saveValidations(trx, selection, validations);

    // 已在首批或前一轮补充中待执行（含 PARTIAL 待手动继续）的子订单不重复入批；驳回或跳过的可再入批。
    const pending = await pendingOrderIds(
      trx,
      appId,
      [...candidates.values()].map((c) => c.orderId),
    );
    const drafts = splitSettlementBillBatches(
      billId,
      validations
        .filter((v) => v.orderId === null || !pending.has(v.orderId))
        .map((v) => ({
          platform,
          order_key: v.orderKey,
          credit_enabled: true,
          result: v.result,
        })),
      maxOrders,
    );
    const batches: ItemRow[][] = drafts.map((draft) =>
      draft.order_keys.map((orderKey) => {
        const c = candidates.get(orderKey);
        if (c === undefined) throw new Error('settlement supplement: batch key without candidate');
        return {
          item_type: 'order',
          order_id: c.orderId,
          user_id: null,
          role: null,
          beneficiary_credit_id: null,
          settle_seq: c.settleSeq,
          b_settle_fen: c.bSettleFen,
        };
      }),
    );

    // ⑫ 补记项：只取本平台 CREDITED 子订单上 open 的义务；同一义务可被多轮纳入，执行时锁内重验。
    for (const item of await openObligationItems(trx, appId, credited)) {
      const last = batches[batches.length - 1];
      if (last !== undefined && last.length < maxOrders) last.push(item);
      else batches.push([item]);
    }

    const batchIds: string[] = [];
    for (const items of batches) {
      const transition = transitionSettleBatch(null, 'GENERATE');
      if (!transition.ok || transition.noop || transition.to !== 'DRAFT') {
        throw new Error('settlement supplement: SB1 GENERATE is not allowed');
      }
      const batchId = newUuidV7(now);
      await trx
        .withSchema('app')
        .insertInto('settle_batches')
        .values({
          batch_id: batchId,
          app_id: appId,
          bill_id: billId,
          platform,
          kind: 'supplement',
          status: transition.to,
          settle_mode: 'IMMEDIATE',
          scheduled_at: null,
          confirmed_by: null,
          confirmed_at: null,
          cancelled_reason: null,
          settle_run_id: null,
          order_count: items.filter((i) => i.item_type === 'order').length,
          started_at: null,
          finished_at: null,
          paused_by_switch_at: null,
        })
        .execute();
      for (const part of chunks(items, INSERT_CHUNK)) {
        await trx
          .withSchema('app')
          .insertInto('settle_batch_items')
          .values(
            part.map((item) => ({
              id: newUuidV7(now),
              app_id: appId,
              batch_id: batchId,
              item_type: item.item_type,
              order_id: item.order_id,
              user_id: item.user_id,
              role: item.role,
              beneficiary_credit_id: item.beneficiary_credit_id,
              settle_seq: item.settle_seq,
              b_settle_fen: item.b_settle_fen,
              amount_fen: null,
              result: null,
              skip_reason: null,
            })),
          )
          .execute();
      }
      batchIds.push(batchId);
    }

    await completeSettleJob(trx, jobId, now, validations.length, heldCount);
    return { outcome: 'generated', billId, platform, batchIds };
  }

  async function execute(
    db: Kysely<DB>,
    appId: string,
    platform: string,
    requestedAt: Date,
    target: Target,
  ): Promise<SupplementResult> {
    const now = deps.clock.now();
    try {
      return await db
        .transaction()
        .execute((trx) => generate(trx, appId, platform, requestedAt, target, now));
    } catch (error) {
      // 前置条件拒绝不写任何表；其余错误时生成事务已整体回滚，另起事务把该键记为 failed，
      // 同键重试经 RETRY 重跑。
      if (!isRejected(error)) {
        try {
          await failSettleJob(db, { appId, job: JOB, platform, runAt: requestedAt }, now);
        } catch {
          // 记失败本身出错时保留原始错误；行仍缺失或为 failed，重试照常可恢复。
        }
      }
      throw error;
    }
  }

  return {
    launch(db, input) {
      return execute(db, input.appId, input.platform, input.requestedAt, {
        billId: input.billId,
      });
    },
    recheckCurrentBill(db, input) {
      return execute(db, input.appId, input.platform, input.requestedAt, { billId: null });
    },
  };
}

async function openObligationItems(
  trx: Transaction<DB>,
  appId: string,
  credited: readonly CreditedFacts[],
): Promise<ItemRow[]> {
  if (credited.length === 0) return [];
  const byOrder = new Map(credited.map((c) => [c.orderId, c]));
  const items: { key: string; id: string; row: ItemRow }[] = [];
  for (const part of chunks([...byOrder.keys()], INSERT_CHUNK)) {
    const open = await trx
      .withSchema('app')
      .selectFrom('beneficiary_credits')
      .select(['beneficiary_credit_id', 'order_id', 'user_id', 'role'])
      .where('app_id', '=', appId)
      .where('status', '=', 'open')
      .where('order_id', 'in', part)
      .execute();
    for (const o of open) {
      const facts = byOrder.get(o.order_id)!;
      items.push({
        key: facts.orderKey,
        id: o.beneficiary_credit_id,
        row: {
          item_type: 'beneficiary',
          order_id: o.order_id,
          user_id: o.user_id,
          role: o.role as ItemRole,
          beneficiary_credit_id: o.beneficiary_credit_id,
          settle_seq: facts.settleSeq,
          b_settle_fen: null,
        },
      });
    }
  }
  items.sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return items.map((i) => i.row);
}
