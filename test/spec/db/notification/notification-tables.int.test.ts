// Rule tests for the notification tables of B1-12a (规划/04 §3.2 rows push_tokens, user_tip_reads,
// inbox_messages and the §3.2 preamble; 08 BR-ID-07 细则「推送令牌与会话」, BR-ATTR-21, BR-INV-03
// 细则, BR-ID-10 细则「推送点击的落点」; OPS-21, OPS-22; D-14; ADR-0001 §4.1 CAS; db/AGENTS.md
// migration rules 4, 6, 7). Real PostgreSQL as couli_app (the notification module writes these
// tables as it). Columns whose shape 04 leaves to the implementation are filled from the catalog
// by kit.ts; 04 marks optional fields 可空, so every other listed field is NOT NULL here.
// Server-side moments (token_set_at, acquired_by_move_at, frozen_until, revoked_at, read_at) are
// written by the application: no SQL clock default (db/AGENTS.md #6). Top-level it() only
// (规划/11 §4.3).
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  NOTIFICATION_TABLES,
  NOT_NULL_VIOLATION,
  PERMISSION_DENIED,
  REJECTED_VALUE,
  UNIQUE_VIOLATION,
  column,
  foreignKeys,
  hasPrivilege,
  insertRow,
  newDevice,
  newUser,
  sqlState,
  unique,
  useDb,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
let readonly: Kysely<DB>;
let payout: Kysely<DB>;
let maint: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  payout = createDb({ connectionString: database.urlFor('couli_payout'), max: 1 });
  maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 1 });
  useDb(app);
});

afterAll(async () => {
  await destroyDb(app);
  await destroyDb(readonly);
  await destroyDb(payout);
  await destroyDb(maint);
  await database.drop();
});

const SET_AT = new Date('2026-10-04T08:00:00Z');
const LATER = new Date('2026-10-04T09:00:00Z');

/** Column shape check: type (udt_name), nullability and whether a default exists. */
async function expectColumn(
  table: string,
  name: string,
  shape: { type?: string; nullable: boolean; hasDefault?: boolean },
): Promise<void> {
  const c = await column(table, name);
  expect(c, `${table}.${name} exists`).toBeDefined();
  if (shape.type !== undefined) expect(c?.type, `${table}.${name} type`).toBe(shape.type);
  expect(c?.nullable, `${table}.${name} nullable`).toBe(shape.nullable);
  if (shape.hasDefault !== undefined) {
    expect(c?.hasDefault, `${table}.${name} default`).toBe(shape.hasDefault);
  }
}

async function typeOf(table: string, name: string): Promise<string> {
  const type = (await column(table, name))?.type;
  expect(type, `${table}.${name} exists`).toBeDefined();
  return type ?? 'missing';
}

/** Inserts a push_tokens row on a new device of the app unless a device is given. */
async function newToken(values: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const appId = typeof values['app_id'] === 'string' ? values['app_id'] : 'couli';
  return insertRow('push_tokens', {
    app_id: appId,
    device_id: values['device_id'] ?? (await newDevice(appId)),
    provider: 'apns',
    token: unique('tok-'),
    token_set_at: SET_AT,
    ...values,
  });
}

// ---------------------------------------------------------------------------------------------
// All three tables (04 §3.2 preamble; db/AGENTS.md #7)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-12a#1] the three tables exist in schema app with app_id NOT NULL and created_at (04 §3.2 preamble)', async () => {
  const appIdType = await typeOf('users', 'app_id');
  for (const table of NOTIFICATION_TABLES) {
    await expectColumn(table, 'app_id', { type: appIdType, nullable: false });
    await expectColumn(table, 'created_at', { type: 'timestamptz', nullable: false });
  }
});

it('[AC-B1-12a#2] foreign keys of the three tables never cascade (db/AGENTS.md #7)', async () => {
  for (const table of NOTIFICATION_TABLES) {
    for (const fk of await foreignKeys(table)) {
      const label = `${table}.${fk.name}`;
      // a = NO ACTION, r = RESTRICT; c / n / d (cascade, set null, set default) are forbidden.
      expect(['a', 'r'], `${label} ON DELETE`).toContain(fk.onDelete);
      expect(['a', 'r'], `${label} ON UPDATE`).toContain(fk.onUpdate);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// push_tokens (04 §3.2 push_tokens; BR-ID-07 细则「推送令牌与会话」; OPS-21, OPS-22; D-14)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-12a#3] push_tokens has the 04 columns: optional user_id and bound_sid, required device_id, provider, token (04 §3.2 push_tokens)', async () => {
  await expectColumn('push_tokens', 'user_id', {
    type: await typeOf('users', 'id'),
    nullable: true,
  });
  // bound_sid is the session that created the binding: same type as devices.last_login_sid.
  await expectColumn('push_tokens', 'bound_sid', {
    type: await typeOf('devices', 'last_login_sid'),
    nullable: true,
  });
  await expectColumn('push_tokens', 'device_id', {
    type: await typeOf('devices', 'id'),
    nullable: false,
  });
  await expectColumn('push_tokens', 'provider', { type: 'text', nullable: false });
  await expectColumn('push_tokens', 'token', { type: 'text', nullable: false });
  await expectColumn('push_tokens', 'updated_at', { type: 'timestamptz', nullable: false });
});

it('[AC-B1-12a#4] token_set_at is a required server moment; acquired_by_move_at, frozen_until and revoked_at are optional; none has a default (04 §3.2 push_tokens; db/AGENTS.md #6)', async () => {
  await expectColumn('push_tokens', 'token_set_at', {
    type: 'timestamptz',
    nullable: false,
    hasDefault: false,
  });
  for (const name of ['acquired_by_move_at', 'frozen_until', 'revoked_at']) {
    await expectColumn('push_tokens', name, {
      type: 'timestamptz',
      nullable: true,
      hasDefault: false,
    });
  }
  // A row reported for the first time carries none of the optional moments and no binding.
  const row = await newToken({ user_id: null, bound_sid: null });
  const stored = await sql<{ empty: boolean }>`
    SELECT acquired_by_move_at IS NULL AND frozen_until IS NULL AND revoked_at IS NULL
           AND user_id IS NULL AND bound_sid IS NULL AS empty
    FROM app.push_tokens WHERE app_id = 'couli' AND device_id = ${row['device_id']}
  `.execute(app);
  expect(stored.rows).toEqual([{ empty: true }]);
});

it('[AC-B1-12a#5] provider stays open text before the provider is chosen (D-14; 04 §3.2 push_tokens)', async () => {
  for (const provider of ['apns', 'jpush', 'getui', 'hms_push_kit', 'vendor_channel_x']) {
    expect(await sqlState(newToken({ provider })), provider).toBe('no error');
  }
});

it('[AC-B1-12a#6] one row per (app_id, device_id, provider), revoked rows included (04 §3.2 push_tokens)', async () => {
  const device = await newDevice();
  await newToken({ device_id: device, provider: 'apns' });
  expect(await sqlState(newToken({ device_id: device, provider: 'apns' }))).toBe(UNIQUE_VIOLATION);
  // Another provider on the same device is another row.
  expect(await sqlState(newToken({ device_id: device, provider: 'jpush' }))).toBe('no error');
  // The key is not partial: a revoked row still holds its (device, provider).
  await sql`UPDATE app.push_tokens SET revoked_at = ${LATER}
            WHERE app_id = 'couli' AND device_id = ${device} AND provider = 'apns'`.execute(app);
  expect(await sqlState(newToken({ device_id: device, provider: 'apns' }))).toBe(UNIQUE_VIOLATION);
});

it('[AC-B1-12a#7] one token value has one live row per (app_id, provider) (04 §3.2 push_tokens: 部分唯一 WHERE revoked_at IS NULL)', async () => {
  const token = unique('tok-');
  await newToken({ token });
  expect(await sqlState(newToken({ token }))).toBe(UNIQUE_VIOLATION);
  // Moving the value onto a live row of another device is rejected as well.
  const other = await newToken();
  expect(
    await sqlState(
      sql`UPDATE app.push_tokens SET token = ${token}
          WHERE app_id = 'couli' AND device_id = ${other['device_id']}`.execute(app),
    ),
  ).toBe(UNIQUE_VIOLATION);
});

it('[AC-B1-12a#8] a revoked row does not hold the token value: the move revokes the other row, then takes the value (04 §3.2 push_tokens; BR-ID-07 细则)', async () => {
  const token = unique('tok-');
  const holder = await newToken({ token });
  const taker = await newToken();
  await sql`UPDATE app.push_tokens SET revoked_at = ${LATER}
            WHERE app_id = 'couli' AND device_id = ${holder['device_id']}`.execute(app);
  expect(
    await sqlState(
      sql`UPDATE app.push_tokens SET token = ${token}, token_set_at = ${LATER},
                 acquired_by_move_at = ${LATER}
          WHERE app_id = 'couli' AND device_id = ${taker['device_id']}`.execute(app),
    ),
  ).toBe('no error');
  // Several revoked rows may keep the same value.
  await sql`UPDATE app.push_tokens SET revoked_at = ${LATER}
            WHERE app_id = 'couli' AND device_id = ${taker['device_id']}`.execute(app);
  expect(await sqlState(newToken({ token, revoked_at: LATER }))).toBe('no error');
  // Reviving a revoked row while another live row holds the value is rejected.
  await newToken({ token });
  expect(
    await sqlState(
      sql`UPDATE app.push_tokens SET revoked_at = NULL
          WHERE app_id = 'couli' AND device_id = ${holder['device_id']}`.execute(app),
    ),
  ).toBe(UNIQUE_VIOLATION);
});

it('[AC-B1-12a#9] the same token value is independent across providers and apps (04 §3.2: 业务唯一键以 app_id 开头)', async () => {
  const token = unique('tok-');
  await newToken({ token, provider: 'apns' });
  expect(await sqlState(newToken({ token, provider: 'jpush' }))).toBe('no error');
  expect(await sqlState(newToken({ token, provider: 'apns', app_id: 'couli_two' }))).toBe(
    'no error',
  );
});

it('[AC-B1-12a#10] a frozen holder is unbound and keeps its value; unbinding matches user_id + bound_sid (04 §3.2 push_tokens; OPS-21)', async () => {
  const user = await newUser();
  const sid = unique('sid-');
  const row = await newToken({ user_id: user, bound_sid: sid });
  // A logout of another session of the same user changes nothing.
  const missed = await sql`UPDATE app.push_tokens SET user_id = NULL, bound_sid = NULL
    WHERE app_id = 'couli' AND user_id = ${user} AND bound_sid = ${unique('sid-')}`.execute(app);
  expect(missed.numAffectedRows).toBe(0n);
  // The conflict freeze: frozen_until written and the binding cleared on the holder.
  const frozen = await sql`UPDATE app.push_tokens
    SET frozen_until = ${LATER}, user_id = NULL, bound_sid = NULL, updated_at = ${LATER}
    WHERE app_id = 'couli' AND user_id = ${user} AND bound_sid = ${sid}`.execute(app);
  expect(frozen.numAffectedRows).toBe(1n);
  const stored = await sql<{ ok: boolean }>`
    SELECT user_id IS NULL AND bound_sid IS NULL AND frozen_until = ${LATER}::timestamptz
           AND token = ${row['token']} AND revoked_at IS NULL AS ok
    FROM app.push_tokens WHERE app_id = 'couli' AND device_id = ${row['device_id']}
  `.execute(app);
  expect(stored.rows).toEqual([{ ok: true }]);
});

it('[AC-B1-12a#11] push_tokens.row_version is an integer starting at 0 that only the writer advances (ADR-0001 §4.1 CAS; db/AGENTS.md #8)', async () => {
  await expectColumn('push_tokens', 'row_version', {
    type: 'int4',
    nullable: false,
    hasDefault: true,
  });
  const row = await newToken();
  const device = row['device_id'];
  const version = async (): Promise<string | undefined> => {
    const rows = await sql<{ n: string }>`
      SELECT row_version::text AS n FROM app.push_tokens
      WHERE app_id = 'couli' AND device_id = ${device}
    `.execute(app);
    return rows.rows[0]?.n;
  };
  expect(await version()).toBe('0');
  await sql`UPDATE app.push_tokens SET updated_at = ${LATER}
            WHERE app_id = 'couli' AND device_id = ${device}`.execute(app);
  expect(await version()).toBe('0');
  const first =
    await sql`UPDATE app.push_tokens SET revoked_at = ${LATER}, row_version = row_version + 1
    WHERE app_id = 'couli' AND device_id = ${device} AND row_version = 0`.execute(app);
  expect(first.numAffectedRows).toBe(1n);
  const stale =
    await sql`UPDATE app.push_tokens SET revoked_at = NULL, row_version = row_version + 1
    WHERE app_id = 'couli' AND device_id = ${device} AND row_version = 0`.execute(app);
  expect(stale.numAffectedRows).toBe(0n);
  expect(await version()).toBe('1');
});

it('[AC-B1-12a#12] an invalid token is deleted by couli_app (04 §3.2 push_tokens: 令牌失效即删, OPS-22)', async () => {
  const row = await newToken();
  const removed = await sql`DELETE FROM app.push_tokens
    WHERE app_id = 'couli' AND device_id = ${row['device_id']}`.execute(app);
  expect(removed.numAffectedRows).toBe(1n);
  // The device can report again afterwards.
  expect(await sqlState(newToken({ device_id: row['device_id'], token: row['token'] }))).toBe(
    'no error',
  );
});

// ---------------------------------------------------------------------------------------------
// user_tip_reads (04 §3.2 user_tip_reads; BR-ATTR-21; BR-INV-03 细则; contracts tip_key)
// ---------------------------------------------------------------------------------------------

async function newTipRead(values: Record<string, unknown>): Promise<Record<string, unknown>> {
  return insertRow('user_tip_reads', {
    app_id: 'couli',
    tip_key: 'jump_tip',
    platform: 'taobao',
    read_at: SET_AT,
    ...values,
  });
}

it('[AC-B1-12a#13] user_tip_reads has a required user, tip_key, platform and read_at without default (04 §3.2 user_tip_reads; db/AGENTS.md #6)', async () => {
  await expectColumn('user_tip_reads', 'user_id', {
    type: await typeOf('users', 'id'),
    nullable: false,
  });
  await expectColumn('user_tip_reads', 'tip_key', { nullable: false });
  await expectColumn('user_tip_reads', 'platform', { type: 'text', nullable: false });
  await expectColumn('user_tip_reads', 'read_at', {
    type: 'timestamptz',
    nullable: false,
    hasDefault: false,
  });
});

it('[AC-B1-12a#14] guests write no tip reads: user_id cannot be empty (04 §3.2 user_tip_reads: 游客不写本表)', async () => {
  expect(await sqlState(newTipRead({ user_id: null }))).toBe(NOT_NULL_VIOLATION);
});

it('[AC-B1-12a#15] tip_key is jump_tip or inviter_before_buy (contracts/enums/identity.yaml tip_key; BR-ATTR-21, BR-INV-03 细则)', async () => {
  for (const tipKey of ['jump_tip', 'inviter_before_buy']) {
    expect(
      await sqlState(newTipRead({ user_id: await newUser(), tip_key: tipKey, platform: '' })),
      tipKey,
    ).toBe('no error');
  }
  for (const tipKey of ['JUMP_TIP', 'jump_tip.taobao', 'first_buy', '']) {
    expect(REJECTED_VALUE, JSON.stringify(tipKey)).toContain(
      await sqlState(newTipRead({ user_id: await newUser(), tip_key: tipKey })),
    );
  }
});

it('[AC-B1-12a#16] a tip not split by platform stores an empty platform, never NULL (04 §3.2 user_tip_reads)', async () => {
  const user = await newUser();
  expect(
    await sqlState(newTipRead({ user_id: user, tip_key: 'inviter_before_buy', platform: '' })),
  ).toBe('no error');
  expect(
    await sqlState(
      newTipRead({ user_id: await newUser(), tip_key: 'inviter_before_buy', platform: null }),
    ),
  ).toBe(NOT_NULL_VIOLATION);
  const stored = await sql<{ platform: string }>`
    SELECT platform FROM app.user_tip_reads WHERE app_id = 'couli' AND user_id = ${user}
  `.execute(app);
  expect(stored.rows).toEqual([{ platform: '' }]);
});

it('[AC-B1-12a#17] one read per (app_id, user_id, tip_key, platform) (04 §3.2 user_tip_reads; BR-ATTR-21)', async () => {
  const user = await newUser();
  await newTipRead({ user_id: user, tip_key: 'jump_tip', platform: 'taobao' });
  expect(
    await sqlState(newTipRead({ user_id: user, tip_key: 'jump_tip', platform: 'taobao' })),
  ).toBe(UNIQUE_VIOLATION);
  // jump_tip is read per platform.
  expect(await sqlState(newTipRead({ user_id: user, tip_key: 'jump_tip', platform: 'jd' }))).toBe(
    'no error',
  );
  await newTipRead({ user_id: user, tip_key: 'inviter_before_buy', platform: '' });
  expect(
    await sqlState(newTipRead({ user_id: user, tip_key: 'inviter_before_buy', platform: '' })),
  ).toBe(UNIQUE_VIOLATION);
  // Another user reads the same tip on the same platform.
  expect(
    await sqlState(
      newTipRead({ user_id: await newUser(), tip_key: 'jump_tip', platform: 'taobao' }),
    ),
  ).toBe('no error');
});

it('[AC-B1-12a#18] showing the tip again deletes every row of that user and tip_key, nothing else (04 §3.2 user_tip_reads; BR-ATTR-21)', async () => {
  const user = await newUser();
  const other = await newUser();
  for (const platform of ['taobao', 'jd', 'pdd']) {
    await newTipRead({ user_id: user, tip_key: 'jump_tip', platform });
  }
  await newTipRead({ user_id: user, tip_key: 'inviter_before_buy', platform: '' });
  await newTipRead({ user_id: other, tip_key: 'jump_tip', platform: 'taobao' });
  const removed = await sql`DELETE FROM app.user_tip_reads
    WHERE app_id = 'couli' AND user_id = ${user} AND tip_key = 'jump_tip'`.execute(app);
  expect(removed.numAffectedRows).toBe(3n);
  const left = await sql<{ user_id: string; tip_key: string }>`
    SELECT user_id::text AS user_id, tip_key::text AS tip_key FROM app.user_tip_reads
    WHERE app_id = 'couli' AND user_id IN (${user}, ${other}) ORDER BY tip_key
  `.execute(app);
  expect(left.rows).toEqual([
    { user_id: user, tip_key: 'inviter_before_buy' },
    { user_id: other, tip_key: 'jump_tip' },
  ]);
});

// ---------------------------------------------------------------------------------------------
// inbox_messages (04 §3.2 inbox_messages; BR-ID-10 细则「推送点击的落点」)
// ---------------------------------------------------------------------------------------------

async function newMessage(values: Record<string, unknown> = {}): Promise<string> {
  const messageId = randomUUID();
  await insertRow('inbox_messages', {
    message_id: messageId,
    app_id: 'couli',
    user_id: await newUser(),
    code: 'ORDER_CREDITED',
    title: 'title',
    body: 'body',
    ...values,
  });
  return messageId;
}

it('[AC-B1-12a#19] inbox_messages has the 04 columns: application-generated message_id, user, code, title, body, optional route and read_at (04 §3.2 inbox_messages; db/AGENTS.md #6)', async () => {
  await expectColumn('inbox_messages', 'message_id', {
    type: 'uuid',
    nullable: false,
    hasDefault: false,
  });
  await expectColumn('inbox_messages', 'user_id', {
    type: await typeOf('users', 'id'),
    nullable: false,
  });
  for (const name of ['code', 'title', 'body']) {
    await expectColumn('inbox_messages', name, { type: 'text', nullable: false });
  }
  await expectColumn('inbox_messages', 'route', { type: 'jsonb', nullable: true });
  await expectColumn('inbox_messages', 'read_at', {
    type: 'timestamptz',
    nullable: true,
    hasDefault: false,
  });
});

it('[AC-B1-12a#20] a message_id is issued once (04 §3.2 inbox_messages: 按 message_id 回查)', async () => {
  const messageId = await newMessage();
  expect(await sqlState(newMessage({ message_id: messageId }))).toBe(UNIQUE_VIOLATION);
});

it('[AC-B1-12a#21] route stores {route, params} as jsonb or stays empty (04 §3.2 inbox_messages; BR-ID-10 细则)', async () => {
  const route = { route: 'order_detail', params: { order_id: 'o-1' } };
  const withRoute = await newMessage({ route: JSON.stringify(route) });
  const withoutRoute = await newMessage({ route: null });
  const stored = await sql<{ id: string; route: unknown }>`
    SELECT message_id::text AS id, route FROM app.inbox_messages
    WHERE message_id IN (${withRoute}, ${withoutRoute})
  `.execute(app);
  const byId = new Map(stored.rows.map((r) => [r.id, r.route]));
  expect(byId.get(withRoute)).toEqual(route);
  expect(byId.get(withoutRoute)).toBeNull();
});

it('[AC-B1-12a#22] inbox_messages.row_version starts at 0 and marking read is a CAS update (ADR-0001 §4.1; db/AGENTS.md #8)', async () => {
  await expectColumn('inbox_messages', 'row_version', {
    type: 'int4',
    nullable: false,
    hasDefault: true,
  });
  const messageId = await newMessage();
  const read =
    await sql`UPDATE app.inbox_messages SET read_at = ${LATER}, row_version = row_version + 1
    WHERE message_id = ${messageId} AND row_version = 0 AND read_at IS NULL`.execute(app);
  expect(read.numAffectedRows).toBe(1n);
  const again =
    await sql`UPDATE app.inbox_messages SET read_at = ${LATER}, row_version = row_version + 1
    WHERE message_id = ${messageId} AND row_version = 0`.execute(app);
  expect(again.numAffectedRows).toBe(0n);
  const stored = await sql<{ v: string; read: boolean }>`
    SELECT row_version::text AS v, read_at = ${LATER}::timestamptz AS read
    FROM app.inbox_messages WHERE message_id = ${messageId}
  `.execute(app);
  expect(stored.rows).toEqual([{ v: '1', read: true }]);
});

// ---------------------------------------------------------------------------------------------
// Grants (db/AGENTS.md #4; 04 §3.2: 写者 notification, 令牌失效即删, 重新显示时删除)
// ---------------------------------------------------------------------------------------------

/** Table-level or any column-level grant of the privilege. */
async function mayDo(role: string, table: string, privilege: string): Promise<boolean> {
  if (await hasPrivilege(role, table, privilege)) return true;
  if (privilege === 'DELETE' || privilege === 'TRUNCATE') return false;
  const rows = await sql<{ ok: boolean }>`
    SELECT has_any_column_privilege(${role}, ${`app.${table}`}, ${privilege}) AS ok
  `.execute(app);
  return rows.rows[0]?.ok === true;
}

it('[AC-B1-12a#23] couli_app reads and inserts all three tables, deletes push_tokens and user_tip_reads, never truncates (04 §3.2; db/AGENTS.md #4)', async () => {
  for (const table of NOTIFICATION_TABLES) {
    expect(await hasPrivilege('couli_app', table, 'SELECT'), `${table} SELECT`).toBe(true);
    expect(await mayDo('couli_app', table, 'INSERT'), `${table} INSERT`).toBe(true);
    expect(await hasPrivilege('couli_app', table, 'TRUNCATE'), `${table} TRUNCATE`).toBe(false);
  }
  expect(await hasPrivilege('couli_app', 'push_tokens', 'DELETE')).toBe(true);
  expect(await hasPrivilege('couli_app', 'user_tip_reads', 'DELETE')).toBe(true);
  // push_tokens (binding, freeze, revoke) and inbox_messages (read_at) are updated.
  expect(await mayDo('couli_app', 'push_tokens', 'UPDATE')).toBe(true);
  expect(await mayDo('couli_app', 'inbox_messages', 'UPDATE')).toBe(true);
});

it('[AC-B1-12a#24] couli_readonly reads the three tables and cannot write them', async () => {
  for (const table of NOTIFICATION_TABLES) {
    expect(
      await sqlState(sql`SELECT 1 FROM ${sql.table(`app.${table}`)} LIMIT 1`.execute(readonly)),
      table,
    ).toBe('no error');
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      expect(await mayDo('couli_readonly', table, privilege), `${table} ${privilege}`).toBe(false);
    }
  }
  expect(await sqlState(sql`DELETE FROM app.push_tokens WHERE false`.execute(readonly))).toBe(
    PERMISSION_DENIED,
  );
});

it('[AC-B1-12a#25] couli_payout and couli_maint have no access to the three tables (as 0005, 0006)', async () => {
  for (const table of NOTIFICATION_TABLES) {
    for (const role of ['couli_payout', 'couli_maint']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        expect(await mayDo(role, table, privilege), `${role} ${table} ${privilege}`).toBe(false);
      }
    }
    expect(
      await sqlState(sql`SELECT 1 FROM ${sql.table(`app.${table}`)} LIMIT 1`.execute(maint)),
      table,
    ).toBe(PERMISSION_DENIED);
    expect(
      await sqlState(sql`SELECT 1 FROM ${sql.table(`app.${table}`)} LIMIT 1`.execute(payout)),
      table,
    ).toBe(PERMISSION_DENIED);
  }
});
