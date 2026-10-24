// The orders section of a personal information copy (规划/08 BR-ID-40 细则「导出范围（默认）」「订单」;
// task B1-27f), for identity's PersonalDataCopySources (assembled by app.module).
// readPersonalDataCopyOrders(handle, subject) — every order of the user in the app (orders.app_id,
// orders.user_id), whatever its age (no user query window), as the rows below; nothing of another
// person. Plain SELECTs on the caller's handle (a READ ONLY transaction included): no locking
// clause, no writes, no logging. Does not change any existing read.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface PersonalDataCopyOrderSubject {
  readonly appId: string;
  readonly userId: string;
}

export interface PersonalDataCopyOrderRow {
  readonly order_id: string;
  readonly platform: string;
  readonly sub_order_id: string;
  readonly title: string | null;
  readonly pay_amount_fen: bigint | null;
  readonly platform_status: string;
  readonly rebate_status: string;
  readonly paid_at: Date | null;
  readonly created_at: Date;
}

export async function readPersonalDataCopyOrders(
  handle: Kysely<DB>,
  subject: PersonalDataCopyOrderSubject,
): Promise<readonly PersonalDataCopyOrderRow[]> {
  return handle
    .withSchema('app')
    .selectFrom('orders')
    .select([
      'order_id',
      'platform',
      'sub_order_id',
      'title',
      'pay_amount_fen',
      'platform_status',
      'rebate_status',
      'paid_at',
      'created_at',
    ])
    .where('app_id', '=', subject.appId)
    .where('user_id', '=', subject.userId)
    .orderBy('created_at', 'desc')
    .orderBy('order_id', 'desc')
    .execute();
}
