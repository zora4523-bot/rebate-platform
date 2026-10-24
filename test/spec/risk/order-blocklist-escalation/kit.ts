import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { expect } from 'vitest';
import type { OrderBlocklistHitInput } from '../../../../apps/api/src/modules/risk/application/order-blocklist.ts';
import { START } from '../order-blocklist/kit.ts';

export {
  ABORT,
  RULE,
  START,
  databaseFixture,
  seedUser,
  setup,
  state,
} from '../order-blocklist/kit.ts';
export type { Fixture } from '../order-blocklist/kit.ts';

export type Action = OrderBlocklistHitInput['risk_action'];

export const INDEX = 'risk_hits_blacklist_once_key';
export const SAME_DEVICE = 'SAME_DEVICE_MULTI_ACCOUNT';
export const SAME_DEVICE_INDEX = 'risk_hits_same_device_once_key';
/** D10-293：同名重建，B1-09a 的五列之后加 risk_action，谓词不变。 */
export const ESCALATION_COLUMNS = [
  'app_id',
  'rule_id',
  'ref_type',
  'ref_id',
  'value_hmac',
  'risk_action',
];
export const BLACKLIST_PREDICATE = "(rule_id = 'BLACKLIST_HIT'::text)";

export interface IndexShape {
  is_unique: boolean;
  is_valid: boolean;
  predicate: string | null;
  columns: string[];
}

/** app.risk_hits 上按对象名找到的索引；不看迁移文件名或编号。 */
export async function indexShape(db: Kysely<DB>, name: string): Promise<IndexShape[]> {
  const result = await sql<IndexShape>`SELECT i.indisunique AS is_unique,
      i.indisvalid AS is_valid,
      pg_get_expr(i.indpred, i.indrelid) AS predicate,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, pos)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        ORDER BY k.pos) AS columns
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'app.risk_hits'::regclass AND c.relname = ${name}`.execute(db);
  return result.rows;
}

/**
 * 每个用例先核对新键：键未落地时是断言红，而不是 recordHit 的 ON CONFLICT 找不到仲裁索引。
 */
export async function expectEscalationIndex(db: Kysely<DB>) {
  expect(
    await indexShape(db, INDEX),
    'risk_hits_blacklist_once_key 按 D10-293 在去重键里加 risk_action',
  ).toEqual([
    {
      is_unique: true,
      is_valid: true,
      predicate: BLACKLIST_PREDICATE,
      columns: ESCALATION_COLUMNS,
    },
  ]);
}

export async function seedRules(
  db: Kysely<DB> | Transaction<DB>,
  app: string,
  rules: readonly string[],
) {
  for (const rule of rules) {
    await db
      .insertInto('risk_rules')
      .values({
        id: randomUUID(),
        app_id: app,
        rule_id: rule,
        scene: 'order',
        conditions: {},
        risk_action: 'manual_review',
        status: 'active',
        version: 1,
        created_at: START,
        updated_at: START,
      })
      .execute();
  }
}
