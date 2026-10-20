// Task F1-02zn: the SQL side of the invite reward save guard (../domain/invite-reward.ts), shared
// by the kill-switch and configuration item write transactions so both take the same lock.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

type Json = DB['config_items']['value'];

/**
 * Transaction-level advisory lock of one app's invite reward campaign. Turning the switch on and
 * saving a non-positive amount or budget both take it first, before any row lock, and then read
 * the other side's current value; a READ COMMITTED read after the wait sees the other's commit.
 */
export async function lockInviteReward(trx: Kysely<DB>, appId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`content.invite_reward:${appId}`}, 0))`.execute(
    trx,
  );
}

/** Current values of the named keys of one app, looked up by full key (never by prefix). */
export async function currentConfigValues(
  trx: Kysely<DB>,
  appId: string,
  keys: readonly string[],
): Promise<Map<string, Json>> {
  if (keys.length === 0) return new Map();
  const rows = await trx
    .withSchema('app')
    .selectFrom('config_items')
    .select(['key', 'value'])
    .where('app_id', '=', appId)
    .where('key', 'in', [...keys])
    .execute();
  return new Map(rows.map((row) => [row.key, row.value]));
}
