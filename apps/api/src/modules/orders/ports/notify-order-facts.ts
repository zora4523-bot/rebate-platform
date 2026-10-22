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
  void db;
  void input;
  throw new Error('NotImplemented: readNotifyOrderFacts');
}

/** 只读找回单和条目；不存在返回 null，尚无条目返回 items: []。 */
export async function readNotifyClaimFacts(
  db: Kysely<DB>,
  input: ReadNotifyClaimFactsInput,
): Promise<NotifyClaimFacts | null> {
  void db;
  void input;
  throw new Error('NotImplemented: readNotifyClaimFacts');
}
