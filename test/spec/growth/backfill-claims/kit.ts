import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ClaimStatus } from '../../../../packages/contracts-ts/src/index.ts';

// Explicit cases from contracts/enums/order.yaml; evidence satisfies db/schema.sql.
export const CLAIM_CASES = [
  ['submitted', null],
  ['auto_matched', 'strong'],
  ['manual_review', 'weak'],
  ['approved', 'strong'],
  ['rejected', 'none'],
  ['cancelled', 'strong'],
] as const satisfies ReadonlyArray<readonly [ClaimStatus, string | null]>;

export async function claim(
  db: Kysely<DB>,
  appId: string,
  userId: string,
  [status, evidence]: (typeof CLAIM_CASES)[number],
  now: Date,
) {
  // A claim alone must suffice: no claim_items, order_keys or attributed orders.
  return db
    .withSchema('app')
    .insertInto('claims')
    .values({
      id: randomUUID(),
      app_id: appId,
      user_id: userId,
      platform: 'taobao',
      order_no: randomUUID(),
      order_no_type: 'sub',
      paid_date: '2031-05-05',
      status,
      evidence_level: evidence,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
