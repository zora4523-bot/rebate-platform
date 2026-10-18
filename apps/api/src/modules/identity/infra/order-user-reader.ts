import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export function createOrderUserReader(db: Kysely<DB>): {
  findByAttrCode(input: { appId: string; attrCode: string }): Promise<string | null>;
} {
  void db;
  throw new Error('NotImplemented: createOrderUserReader');
}
