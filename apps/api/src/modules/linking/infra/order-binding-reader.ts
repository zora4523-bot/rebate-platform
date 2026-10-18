// B1-08n: orders' attribution reader over linking's union_bindings (BR-ATTR-06 淘宝 relation_id).
// Every binding of (app_id, union_account_id, relation_id), whatever its status, with its raw
// bound / released / cooldown instants; the window decision is orders' (resolveBinding). One
// SELECT per call, no cache, no write.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export function createOrderBindingReader(db: Kysely<DB>): {
  findByRelation(input: { appId: string; unionAccountId: string; relationId: string }): Promise<
    readonly {
      user_id: string;
      bound_at: Date | null;
      released_at: Date | null;
      cooldown_until: Date | null;
    }[]
  >;
} {
  return {
    async findByRelation(input) {
      return await db
        .withSchema('app')
        .selectFrom('union_bindings')
        .select(['user_id', 'bound_at', 'released_at', 'cooldown_until'])
        .where('app_id', '=', input.appId)
        .where('union_account_id', '=', input.unionAccountId)
        .where('relation_id', '=', input.relationId)
        .orderBy('id')
        .execute();
    },
  };
}
