import { createHash, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll } from 'vitest';

export const NOW = '2026-10-08T04:05:06.789Z';
export type BindingStatus =
  'absent' | 'unbound' | 'pending_auth' | 'invalid' | 'active' | 'blocked' | 'released';

interface DatabaseHandle {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export function databaseFixture(factory: () => Promise<DatabaseHandle>) {
  let handle: DatabaseHandle | undefined;
  let db: Kysely<DB>;
  beforeAll(async () => {
    handle = await factory();
    db = createDb({ connectionString: handle.urlFor('couli_app'), max: 6 });
  }, 180_000);
  afterAll(async () => {
    if (db !== undefined) await destroyDb(db);
    await handle?.drop();
  }, 60_000);
  return () => db;
}

/** Every case has its own tenant, users, devices and selected account; no kit defaults. */
export async function seed(db: Kysely<DB>) {
  const appId = `pdd_auth_${randomUUID().replaceAll('-', '')}`;
  const a = { userId: randomUUID(), deviceId: randomUUID(), attr: 'pdd0000a' };
  const b = { userId: randomUUID(), deviceId: randomUUID(), attr: 'pdd0000b' };
  const accountId = randomUUID();
  for (const person of [a, b]) {
    await db
      .insertInto('users')
      .values({
        id: person.userId,
        app_id: appId,
        nickname: '合成用户',
        avatar: 'https://example.test/avatar',
        invite_code: person.attr,
        attr_code: person.attr,
        level: 'T1',
        register_method: 'synthetic',
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
    await db
      .insertInto('user_risk_state')
      .values({
        app_id: appId,
        user_id: person.userId,
        state: 'normal',
        changed_by: 'synthetic-fixture',
        changed_at: NOW,
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
    await db
      .insertInto('devices')
      .values({
        id: person.deviceId,
        app_id: appId,
        device_hash: createHash('sha256').update(person.deviceId).digest('hex'),
        id_source: 'idfv',
        install_secret_cipher: Buffer.from('synthetic-unused'),
        platform: 'ios',
        app_version: '1.0.0',
        last_seen_at: NOW,
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
  }
  async function account(authStatus: 'active' | 'expired', id = randomUUID()) {
    await db
      .insertInto('union_accounts')
      .values({
        id,
        app_id: appId,
        platform: 'pdd',
        account_name: 'synthetic-account',
        status: 'active',
        auth_status: authStatus,
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
    return id;
  }
  await account('active', accountId);
  async function bind(status: BindingStatus, userId = a.userId, selectedAccount = accountId) {
    if (status === 'absent') return null;
    const id = randomUUID();
    await db
      .insertInto('union_bindings')
      .values({
        id,
        app_id: appId,
        user_id: userId,
        platform: 'pdd',
        union_account_id: selectedAccount,
        status,
        row_version: 7,
        pdd_custom: JSON.stringify({ synthetic: 'old-value' }),
        blocked_reason: status === 'blocked' ? 'admin_disable' : null,
        released_at: status === 'released' ? NOW : null,
        cooldown_until: status === 'released' ? NOW : null,
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
    return id;
  }
  const bindings = () =>
    db.selectFrom('union_bindings').selectAll().where('app_id', '=', appId).orderBy('id').execute();
  const sessions = () =>
    db
      .selectFrom('union_auth_sessions')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('state')
      .execute();
  const logs = () =>
    db
      .selectFrom('link_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .where('event', '=', 'open')
      .orderBy('id')
      .execute();
  const attempts = () =>
    db
      .selectFrom('link_open_attempts')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('attempt_id')
      .execute();
  const links = () =>
    db.selectFrom('links').selectAll().where('app_id', '=', appId).orderBy('link_id').execute();
  async function expire() {
    await db
      .updateTable('union_accounts')
      .set({ auth_status: 'expired' })
      .where('app_id', '=', appId)
      .where('id', '=', accountId)
      .execute();
  }
  return {
    db,
    appId,
    a,
    b,
    accountId,
    bind,
    account,
    bindings,
    sessions,
    logs,
    attempts,
    links,
    expire,
  };
}
