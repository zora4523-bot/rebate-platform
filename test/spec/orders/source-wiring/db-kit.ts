import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Insertable, type Kysely } from 'kysely';
import { at, CREATED, BOUND } from '../wiring/db-kit.ts';

export async function config(db: Kysely<DB>, appId: string, key: string, value: unknown) {
  await db
    .insertInto('config_items')
    .values({
      app_id: appId,
      key,
      value: sql`${JSON.stringify(value)}::jsonb`,
      updated_by: 'synthetic',
      created_at: at(CREATED),
      updated_at: at(BOUND),
    })
    .onConflict((oc) =>
      oc.columns(['app_id', 'key']).doUpdateSet({
        value: sql`${JSON.stringify(value)}::jsonb`,
      }),
    )
    .execute();
}

export async function platform(db: Kysely<DB>, keyPrefix: string | null, code = 'pdd') {
  await db
    .insertInto('platforms')
    .values({
      code,
      key_prefix: keyPrefix,
      key_stability: 'unverified',
      search_support: 'supported',
      convert_support: 'supported',
      order_sync_support: 'supported',
      stage: 'm_beta',
      created_at: at(CREATED),
      updated_at: at(BOUND),
    })
    .execute();
}

export async function click(
  db: Kysely<DB>,
  appId: string,
  userId: string,
  patch: Partial<Insertable<DB['link_logs']>> = {},
) {
  return db
    .insertInto('link_logs')
    .values({
      app_id: appId,
      user_id: userId,
      link_id: randomUUID(),
      platform: 'pdd',
      product_key: 'pp:123',
      shop_id: 'shop-source',
      event: 'open',
      result_code: 0,
      pid_scene: 'share',
      scene: 'search',
      agent_session_id: randomUUID(),
      created_at: at('2026-10-14T12:13:14.000Z'),
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
