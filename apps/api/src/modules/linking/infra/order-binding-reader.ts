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
  void db;
  throw new Error('NotImplemented: createOrderBindingReader');
}
