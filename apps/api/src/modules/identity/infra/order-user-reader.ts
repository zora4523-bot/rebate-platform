// B1-08n: orders' attribution reader over identity's users (BR-ATTR-06; D10-35 裁定 6). The
// reverse of createIdentityAttrCodeReader: attr_code → user_id within one App, one SELECT per call
// (no cache). Status is deliberately not filtered: a deleted account still owns the orders it
// brought in. users is unique on (app_id, attr_code), so at most one row matches.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export function createOrderUserReader(db: Kysely<DB>): {
  findByAttrCode(input: { appId: string; attrCode: string }): Promise<string | null>;
} {
  return {
    async findByAttrCode(input) {
      const row = await db
        .withSchema('app')
        .selectFrom('users')
        .select('id')
        .where('app_id', '=', input.appId)
        .where('attr_code', '=', input.attrCode)
        .executeTakeFirst();
      return row?.id ?? null;
    },
  };
}
