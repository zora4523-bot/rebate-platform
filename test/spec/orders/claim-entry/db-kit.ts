import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Insertable, Kysely } from 'kysely';
import { createClaimEntryReader } from '../../../../apps/api/src/modules/linking/index.ts';
import { createOrderQueries } from '../../../../apps/api/src/modules/orders/index.ts';
import { fixture as listFixture } from '../list-detail/kit.ts';
import { ago, HOUR, value } from './kit.ts';

// Data helpers only. Integration files own their cloned database and application-role handle.
export async function fixture(db: Kysely<DB>) {
  const base = await listFixture(db);
  async function log(patch: Partial<Insertable<DB['link_logs']>> = {}) {
    return db
      .insertInto('link_logs')
      .values({
        ...base.subject,
        opener_user_id: base.subject.user_id,
        platform: 'taobao',
        event: 'open',
        result_code: 0,
        pid_scene: 'self',
        no_rebate: false,
        no_rebate_reason: null,
        created_at: ago(HOUR),
        ...patch,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  async function binding(patch: Partial<Insertable<DB['union_bindings']>> = {}) {
    const accountId = randomUUID();
    const platform = patch.platform ?? 'taobao';
    const appId = patch.app_id ?? base.subject.app_id;
    await db
      .insertInto('union_accounts')
      .values({
        id: accountId,
        app_id: appId,
        platform,
        account_name: 'synthetic claim-entry',
        status: 'active',
        auth_status: 'active',
      })
      .execute();
    return db
      .insertInto('union_bindings')
      .values({
        id: randomUUID(),
        ...base.subject,
        union_account_id: accountId,
        platform,
        status: 'active',
        bound_at: ago(HOUR - 1),
        relation_id: 'synthetic-' + randomUUID().slice(0, 8),
        created_at: ago(0),
        updated_at: ago(0),
        ...patch,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  async function queries() {
    const claimEntry = await value(() => createClaimEntryReader(db));
    return value(() => createOrderQueries({ ...base.deps, claimEntry }));
  }
  return { ...base, log, binding, queries };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
