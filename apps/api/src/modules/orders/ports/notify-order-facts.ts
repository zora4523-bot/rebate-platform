// B1-12j: read-only ports for trade notifications (BR-TEXT-09). Plain SELECTs filtered by app_id,
// no lock and no write, so they also run inside READ ONLY transactions; values are returned as
// stored (no title truncation, no default owner or buy_type, bigint amounts kept as bigint).
import type { DB } from '@couli/db';
import type { Kysely, Selectable } from 'kysely';

export interface ReadNotifyOrderFactsInput {
  app_id: string;
  order_id: string;
}

export type NotifyOrderFacts = Pick<
  Selectable<DB['orders']>,
  | 'order_id'
  | 'platform'
  | 'sub_order_id'
  | 'user_id'
  | 'buy_type'
  | 'title'
  | 'platform_status'
  | 'est_commission_fen'
  | 'commission_version'
>;

export interface ReadNotifyClaimFactsInput {
  app_id: string;
  claim_id: string;
}

export type NotifyClaimItem = Pick<
  Selectable<DB['claim_items']>,
  'order_id' | 'decision' | 'reject_reason'
> & { item_id: string };

export interface NotifyClaimFacts {
  claim_id: string;
  /** 来源为 claims.user_id，不是订单当前归属用户。 */
  applicant_user_id: string;
  status: Selectable<DB['claims']>['status'];
  items: NotifyClaimItem[];
}

/** 返回原始订单事实；模板裁剪、金额计算与通知资格由调用方处理。 */
export async function readNotifyOrderFacts(
  db: Kysely<DB>,
  input: ReadNotifyOrderFactsInput,
): Promise<NotifyOrderFacts | null> {
  const row = await db
    .withSchema('app')
    .selectFrom('orders')
    .select([
      'order_id',
      'platform',
      'sub_order_id',
      'user_id',
      'buy_type',
      'title',
      'platform_status',
      'est_commission_fen',
      'commission_version',
    ])
    .where('app_id', '=', input.app_id)
    .where('order_id', '=', input.order_id)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    order_id: row.order_id,
    platform: row.platform,
    sub_order_id: row.sub_order_id,
    user_id: row.user_id,
    buy_type: row.buy_type,
    title: row.title,
    platform_status: row.platform_status,
    est_commission_fen: row.est_commission_fen,
    commission_version: row.commission_version,
  };
}

/** 只读找回单和条目；不存在返回 null，尚无条目返回 items: []。 */
export async function readNotifyClaimFacts(
  db: Kysely<DB>,
  input: ReadNotifyClaimFactsInput,
): Promise<NotifyClaimFacts | null> {
  const app = db.withSchema('app');
  const claim = await app
    .selectFrom('claims')
    .select(['id', 'user_id', 'status'])
    .where('app_id', '=', input.app_id)
    .where('id', '=', input.claim_id)
    .executeTakeFirst();
  if (claim === undefined) return null;
  const items = await app
    .selectFrom('claim_items')
    .select(['id', 'order_id', 'decision', 'reject_reason'])
    .where('app_id', '=', input.app_id)
    .where('claim_id', '=', claim.id)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return {
    claim_id: claim.id,
    applicant_user_id: claim.user_id,
    status: claim.status,
    items: items.map((item) => ({
      item_id: item.id,
      order_id: item.order_id,
      decision: item.decision,
      reject_reason: item.reject_reason,
    })),
  };
}
