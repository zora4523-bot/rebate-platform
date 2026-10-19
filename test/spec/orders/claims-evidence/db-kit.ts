import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Insertable, Kysely } from 'kysely';
import { expect } from 'vitest';
import type { RedisHandle } from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { fixture as submitFixture, at, ATTR } from '../claims-submit/kit.ts';

/** Only data helpers here; database cloning belongs to the integration test files. */
export async function fixture(db: Kysely<DB>, redis: RedisHandle) {
  const base = await submitFixture(db, redis);
  async function log(patch: Partial<Insertable<DB['link_logs']>> = {}) {
    const row = {
      ...base.subject,
      platform: 'taobao',
      event: 'open',
      product_key: 'tb:123',
      shop_id: 'shop-1',
      result_code: 0,
      no_rebate: false,
      created_at: at('2028-01-12T12:00:00.000Z'),
      ...patch,
    } satisfies Insertable<DB['link_logs']>;
    const inserted = await db
      .insertInto('link_logs')
      .values(row)
      .returning('id')
      .executeTakeFirstOrThrow();
    return { ...row, id: inserted.id };
  }
  async function account(platform = 'taobao', appId = base.subject.app_id) {
    const id = randomUUID();
    await db
      .insertInto('union_accounts')
      .values({
        id,
        app_id: appId,
        platform,
        account_name: 'synthetic claim authorization',
        status: 'active',
        auth_status: 'active',
      })
      .execute();
    return id;
  }
  async function binding(patch: Partial<Insertable<DB['union_bindings']>> = {}) {
    const platform = patch.platform ?? 'taobao';
    const union_account_id = await account(platform, patch.app_id ?? base.subject.app_id);
    const row = {
      id: randomUUID(),
      ...base.subject,
      platform,
      union_account_id,
      status: 'active',
      bound_at: at('2028-01-15T02:00:00.000Z'),
      created_at: base.clock.now(),
      updated_at: base.clock.now(),
      ...patch,
    } satisfies Insertable<DB['union_bindings']>;
    await db.insertInto('union_bindings').values(row).execute();
    return row;
  }
  async function conflict(patch: Partial<Insertable<DB['union_binding_conflicts']>> = {}) {
    const platform = patch.platform ?? 'taobao';
    const union_account_id = await account(platform, patch.app_id ?? base.subject.app_id);
    const row = {
      id: randomUUID(),
      ...base.subject,
      platform,
      union_account_id,
      kind: 'occupied',
      occurred_at: at('2028-01-14T12:00:00.000Z'),
      resolved_at: null,
      resolution: null,
      ...patch,
    } satisfies Insertable<DB['union_binding_conflicts']>;
    await db.insertInto('union_binding_conflicts').values(row).execute();
    return row;
  }
  const seed = (patch: Partial<Insertable<DB['orders']>> = {}) =>
    base.seed({
      platform: 'taobao',
      product_key: 'tb:123',
      raw_item_id: '123',
      shop_id: 'shop-1',
      attr_at: at(ATTR),
      ...patch,
    });
  return { ...base, seed, log, binding, conflict };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export async function persisted(
  f: Fixture,
  levels: ('strong' | 'weak' | 'none')[],
  ids: string[][],
) {
  const weakest = levels.includes('none') ? 'none' : levels.includes('weak') ? 'weak' : 'strong';
  const claims = await f.claims();
  expect(claims).toHaveLength(1);
  expect(claims[0]).toMatchObject({
    status: weakest === 'strong' ? 'auto_matched' : 'manual_review',
    evidence_level: weakest,
    updated_at: f.clock.now(),
    row_version: 1,
  });
  const items = await f.items();
  expect(items.map((r) => r.evidence)).toEqual(levels);
  expect(items.map((r) => r.evidence_link_log_ids?.map(String))).toEqual(ids);
  for (const item of items)
    expect(item).toMatchObject({
      decision: null,
      decided_at: null,
      decided_by: null,
      reject_reason: null,
      updated_at: f.clock.now(),
      row_version: 1,
    });
}
