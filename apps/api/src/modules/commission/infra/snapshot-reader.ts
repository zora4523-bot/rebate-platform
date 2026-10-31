// B2-04i: Kysely reads of the four snapshot tables of migration 0036, always inside the caller's
// transaction. SELECT only — no locking clause (the caller holds the order lock; FOR SHARE would
// fail in READ ONLY transactions and for couli_readonly), no SQL clock. Every query is filtered by
// both app_id and order_id.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface StoredSplit {
  readonly ruleVersionId: string;
  readonly reserveBp: number;
  readonly beneficiaries: unknown;
}

export async function selectSplit(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
): Promise<StoredSplit | undefined> {
  const row = await trx
    .withSchema('app')
    .selectFrom('commission_splits')
    .select(['rule_version_id', 'reserve_bp', 'beneficiaries'])
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    ruleVersionId: row.rule_version_id,
    reserveBp: row.reserve_bp,
    beneficiaries: row.beneficiaries,
  };
}

/** Greatest commission_version in commission_split_totals and in commission_split_amounts. */
export async function selectMaxVersions(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
): Promise<{ readonly totals: number | null; readonly amounts: number | null }> {
  const app = trx.withSchema('app');
  const totals = await app
    .selectFrom('commission_split_totals')
    .select((eb) => eb.fn.max('commission_version').as('v'))
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .executeTakeFirst();
  const amounts = await app
    .selectFrom('commission_split_amounts')
    .select((eb) => eb.fn.max('commission_version').as('v'))
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .executeTakeFirst();
  return { totals: totals?.v ?? null, amounts: amounts?.v ?? null };
}

/** B of one version: the totals row plus the distinct base_fen values of its amount rows. */
export async function selectVersionBase(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
  version: number,
): Promise<{ readonly totalsBase: bigint | undefined; readonly amountBases: readonly bigint[] }> {
  const app = trx.withSchema('app');
  const totals = await app
    .selectFrom('commission_split_totals')
    .select('base_fen')
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .where('commission_version', '=', version)
    .executeTakeFirst();
  const amounts = await app
    .selectFrom('commission_split_amounts')
    .select('base_fen')
    .distinct()
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .where('commission_version', '=', version)
    .execute();
  return { totalsBase: totals?.base_fen, amountBases: amounts.map((a) => a.base_fen) };
}

export interface StoredForfeitedEvent {
  readonly eventSeq: bigint;
  readonly userId: string;
  readonly role: string;
  readonly reason: string | null;
}

/**
 * The order's forfeited events still in force, oldest event_seq first (not created_at). An active
 * event (only an appeal restore appends one) ends every earlier forfeiture of the same (user_id,
 * role) on the order (BR-FUND-22 ③「补发后该受益人不再按被剥夺处理」, BR-CALC-09 申诉恢复例外); a forfeited
 * event after it lists the share again, with its own reason. Order is by event_seq only.
 */
export async function selectForfeitedEvents(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
): Promise<StoredForfeitedEvent[]> {
  const rows = await trx
    .withSchema('app')
    .selectFrom('commission_split_beneficiary_events as e')
    .select(['e.event_seq', 'e.user_id', 'e.role', 'e.reason'])
    .where('e.app_id', '=', appId)
    .where('e.order_id', '=', orderId)
    .where('e.status', '=', 'forfeited')
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('commission_split_beneficiary_events as restored')
            .select('restored.event_seq')
            .where('restored.app_id', '=', appId)
            .where('restored.order_id', '=', orderId)
            .whereRef('restored.user_id', '=', 'e.user_id')
            .whereRef('restored.role', '=', 'e.role')
            .where('restored.status', '=', 'active')
            .whereRef('restored.event_seq', '>', 'e.event_seq'),
        ),
      ),
    )
    .orderBy('e.event_seq')
    .execute();
  return rows.map((r) => ({
    eventSeq: r.event_seq,
    userId: r.user_id,
    role: r.role,
    reason: r.reason,
  }));
}
