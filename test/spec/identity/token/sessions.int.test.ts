import { createHash, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createSession,
  revokeSession,
} from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { DbHandles } from '../../../../apps/api/src/modules/platform/db/index.ts';
import { contract, ROOT, type Response } from '../../risk/signature/kit.ts';
import { envelopeValidator } from '../../platform/errors/kit.ts';
import { HEADERS, PRINCIPAL, fixture } from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 6 });
});
afterAll(async () => {
  try {
    if (db !== undefined) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

async function seed(clock: FixedClock, appId = 'couli', uid = randomUUID()) {
  const deviceId = randomUUID();
  await sql`INSERT INTO app.users (id,app_id,nickname,avatar,invite_code,attr_code,level,register_method)
    VALUES (${uid},${appId},'token test','test-avatar',${randomUUID()},${randomUUID()},'normal','sms')
    ON CONFLICT (id) DO NOTHING`.execute(db);
  await sql`INSERT INTO app.devices (id,app_id,device_hash,id_source,install_secret_cipher,platform,app_version,last_seen_at)
    VALUES (${deviceId},${appId},${createHash('sha256').update(deviceId).digest('hex')},'idfv',${Buffer.from('fixture-not-used-for-signatures')},'ios','2.0.0',${clock.now()})`.execute(
    db,
  );
  return { ...PRINCIPAL, uid, app_id: appId, device_id: deviceId };
}

function sessionRow(appId: string, sid: string) {
  return db
    .withSchema('app')
    .selectFrom('sessions')
    .selectAll()
    .where('app_id', '=', appId)
    .where('sid', '=', sid)
    .executeTakeFirstOrThrow();
}
function deviceRow(id: string) {
  return db
    .withSchema('app')
    .selectFrom('devices')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}
function refreshRows(appId: string, sid: string) {
  return db
    .withSchema('app')
    .selectFrom('refresh_tokens')
    .selectAll()
    .where('app_id', '=', appId)
    .where('sid', '=', sid)
    .orderBy('id')
    .execute();
}

it('[BR-ID-07][04 §3.2] 同一事务创建会话、SHA-256 refresh和last_login_sid；业务时刻均来自Clock', async () => {
  const deps = fixture();
  const principal = await seed(deps.clock);
  const before = await deviceRow(principal.device_id);
  let extensionSid: string | undefined;
  const issued = await db.transaction().execute((trx) =>
    createSession(trx, principal, deps, async (sameTransaction, session) => {
      expect(sameTransaction).toBe(trx);
      const row = await sameTransaction
        .withSchema('app')
        .selectFrom('devices')
        .select('last_login_sid')
        .where('id', '=', principal.device_id)
        .executeTakeFirstOrThrow();
      expect(row.last_login_sid).toBe(session.sid);
      extensionSid = session.sid;
    }),
  );
  expect(extensionSid).toBe(issued.sid);
  expect(issued.session_scope).toBe('full');
  expect(await deps.tokens.verifyAccess(issued.access_token)).toEqual({
    ...principal,
    sid: issued.sid,
  });
  const row = await sessionRow(principal.app_id, issued.sid);
  expect(row).toMatchObject({
    app_id: principal.app_id,
    user_id: principal.uid,
    device_id: principal.device_id,
    revoked_at: null,
    revoke_reason: null,
    created_at: deps.clock.now(),
  });
  expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const device = await deviceRow(principal.device_id);
  expect(device.last_login_sid).toBe(issued.sid);
  expect(device.row_version).toBe(before.row_version + 1);
  const refresh = await refreshRows(principal.app_id, issued.sid);
  expect(refresh).toHaveLength(1);
  expect(refresh[0]).toMatchObject({
    parent_hash: null,
    rotated_at: null,
    created_at: deps.clock.now(),
  });
  expect(refresh[0]!.expire_at.getTime() - deps.clock.now().getTime()).toBe(30 * 86400_000);
  expect(
    ['hex', 'base64url'].map((encoding) =>
      createHash('sha256')
        .update(issued.refresh_token)
        .digest(encoding as 'hex' | 'base64url'),
    ),
  ).toContain(refresh[0]!.token_hash);
  expect(JSON.stringify([row, device, refresh])).not.toContain(issued.refresh_token);
});

it('[BR-ID-07] 调用方回滚或同事务扩展点失败时，三处写入一起回滚', async () => {
  const deps = fixture();
  const principal = await seed(deps.clock);
  const before = await deviceRow(principal.device_id);
  const abort = new Error('caller-aborted');
  for (const extensionFails of [false, true]) {
    await expect(
      db.transaction().execute(async (trx) => {
        await createSession(
          trx,
          principal,
          deps,
          extensionFails
            ? async () => {
                throw abort;
              }
            : undefined,
        );
        throw abort;
      }),
    ).rejects.toBe(abort);
    expect(await deviceRow(principal.device_id)).toEqual(before);
    expect(
      await db
        .withSchema('app')
        .selectFrom('sessions')
        .selectAll()
        .where('device_id', '=', principal.device_id)
        .execute(),
    ).toEqual([]);
  }
});

it('[BR-ID-07] 同设备并发创建会话串行更新last_login_sid，row_version不丢更新', async () => {
  const deps = fixture();
  const principal = await seed(deps.clock);
  const before = await deviceRow(principal.device_id);
  const order: string[] = [];
  const sessions = await Promise.all(
    [1, 2].map(() =>
      db.transaction().execute((trx) =>
        createSession(trx, principal, deps, async (sameTransaction, session) => {
          expect(sameTransaction).toBe(trx);
          const row = await sameTransaction
            .withSchema('app')
            .selectFrom('devices')
            .select('last_login_sid')
            .where('id', '=', principal.device_id)
            .executeTakeFirstOrThrow();
          expect(row.last_login_sid).toBe(session.sid);
          order.push(session.sid);
        }),
      ),
    ),
  );
  expect(new Set(sessions.map((session) => session.sid)).size).toBe(2);
  const after = await deviceRow(principal.device_id);
  expect(after.last_login_sid).toBe(order.at(-1));
  expect(after.row_version).toBe(before.row_version + 2);
});

it('[BR-ID-07] 吊销仅填sessions空列一次；整条refresh链保持原值，不伪造轮换', async () => {
  const deps = fixture();
  const principal = await seed(deps.clock);
  const issued = await db.transaction().execute((trx) => createSession(trx, principal, deps));
  const [first] = await refreshRows(principal.app_id, issued.sid);
  expect(first).toBeDefined();
  await db
    .withSchema('app')
    .insertInto('refresh_tokens')
    .values({
      id: randomUUID(),
      app_id: principal.app_id,
      sid: issued.sid,
      token_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      parent_hash: first!.token_hash,
      expire_at: first!.expire_at,
      rotated_at: null,
    })
    .execute();
  const chain = await refreshRows(principal.app_id, issued.sid);
  const other = await seed(deps.clock, 'couli-other');
  await db
    .withSchema('app')
    .insertInto('sessions')
    .values({
      id: randomUUID(),
      sid: issued.sid,
      app_id: other.app_id,
      user_id: other.uid,
      device_id: other.device_id,
      revoked_at: null,
      revoke_reason: null,
      created_at: deps.clock.now(),
    })
    .execute();
  deps.clock.advanceMs(1000);
  expect(
    await db
      .transaction()
      .execute((trx) =>
        revokeSession(
          trx,
          { app_id: principal.app_id, sid: issued.sid, reason: 'test-first' },
          deps.clock,
        ),
      ),
  ).toBe(true);
  const revoked = await sessionRow(principal.app_id, issued.sid);
  expect(revoked.revoked_at).toEqual(deps.clock.now());
  expect(revoked.revoke_reason).not.toBeNull();
  deps.clock.advanceMs(1000);
  expect(
    await db
      .transaction()
      .execute((trx) =>
        revokeSession(
          trx,
          { app_id: principal.app_id, sid: issued.sid, reason: 'test-second' },
          deps.clock,
        ),
      ),
  ).toBe(false);
  expect(await sessionRow(principal.app_id, issued.sid)).toEqual(revoked);
  expect(await refreshRows(principal.app_id, issued.sid)).toEqual(chain);
  expect((await sessionRow(other.app_id, issued.sid)).revoked_at).toBeNull();
});

it('[BR-ID-07] 吊销遵守调用方回滚；并发吊销只允许一次写入', async () => {
  const deps = fixture();
  const principal = await seed(deps.clock);
  const issued = await db.transaction().execute((trx) => createSession(trx, principal, deps));
  const before = await sessionRow(principal.app_id, issued.sid);
  const abort = new Error('revoke-rollback');
  await expect(
    db.transaction().execute(async (trx) => {
      expect(
        await revokeSession(
          trx,
          { app_id: principal.app_id, sid: issued.sid, reason: 'rollback' },
          deps.clock,
        ),
      ).toBe(true);
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await sessionRow(principal.app_id, issued.sid)).toEqual(before);
  const results = await Promise.all(
    ['concurrent-a', 'concurrent-b'].map((reason) =>
      db
        .transaction()
        .execute((trx) =>
          revokeSession(trx, { app_id: principal.app_id, sid: issued.sid, reason }, deps.clock),
        ),
    ),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  expect((await sessionRow(principal.app_id, issued.sid)).revoked_at).toEqual(deps.clock.now());
});

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(request: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
}
const BOOTSTRAP = new URL('apps/api/src/bootstrap.ts', ROOT).href;
async function buildApp(deps: ReturnType<typeof fixture>, lines: string[]) {
  const { createHttpApp } = (await import(BOOTSTRAP)) as {
    createHttpApp(
      entry: 'api',
      overrides: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: ReturnType<typeof createRootLogger>;
        dbHandles: DbHandles;
      },
    ): Promise<HttpApp>;
  };
  return createHttpApp('api', {
    config: loadConfig({
      APP_ENV: 'test',
      JWT_KEY_ID: deps.keyring.kid,
      JWT_PRIVATE_KEY_PEM: deps.keyring.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    }),
    clock: deps.clock,
    logger: createRootLogger(
      { entry: 'api', appEnv: 'test', level: 'trace' },
      { write: (line: string) => void lines.push(line) },
    ),
    dbHandles: { db, dbRead: null, close: async () => undefined },
  });
}

async function rejected(response: Response, code: number) {
  expect(response.statusCode).toBe(code === 10403 ? 403 : 401);
  const body = response.json();
  expect((await envelopeValidator())(body)).toBe(true);
  expect(body['code']).toBe(code);
  expect(body).not.toHaveProperty('data');
}

for (const scope of ['full', 'deletion_only'] as const) {
  it(`[BR-ID-07][04 §6.1] 真实logout接受${scope}；吊销当前sid、重复10002、另一设备仍可用`, async () => {
    const deps = fixture();
    const principal = { ...(await seed(deps.clock)), scp: scope };
    const another = await seed(deps.clock, principal.app_id, principal.uid);
    const issued = await db.transaction().execute((trx) => createSession(trx, principal, deps));
    const other = await db.transaction().execute((trx) => createSession(trx, another, deps));
    const chain = await refreshRows(principal.app_id, issued.sid);
    const lines: string[] = [];
    const app = await buildApp(deps, lines);
    try {
      await app.init();
      const headers = {
        ...HEADERS,
        'x-device-id': principal.device_id,
        'x-app-version': '0.0.1',
        authorization: `Bearer ${issued.access_token}`,
      };
      const logout = () => app.inject({ method: 'POST', url: '/v1/auth/logout', headers });
      const response = await logout();
      expect(response.statusCode).toBe(200);
      const operation = (await contract()).paths['/v1/auth/logout']?.post;
      expect(operation).toBeDefined();
      expect(operation!['x-implementation']).not.toBe('planned');
      const responses = operation!['responses'] as Record<
        string,
        { content: Record<string, { schema: JsonSchema }> }
      >;
      const schema = responses['200']?.content['application/json']?.schema;
      expect(schema).toBeDefined();
      const validate = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
      expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
      expect(response.json()).toMatchObject({ code: 0, data: {} });
      const revoked = await sessionRow(principal.app_id, issued.sid);
      expect(revoked.revoked_at).toEqual(deps.clock.now());
      deps.clock.advanceMs(1000);
      await rejected(await logout(), 10002);
      expect(await sessionRow(principal.app_id, issued.sid)).toEqual(revoked);
      expect(await refreshRows(principal.app_id, issued.sid)).toEqual(chain);
      expect((await sessionRow(another.app_id, other.sid)).revoked_at).toBeNull();
      const otherResponse = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: {
          ...HEADERS,
          'x-device-id': another.device_id,
          authorization: `Bearer ${other.access_token}`,
        },
      });
      expect(otherResponse.statusCode).toBe(200);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(lines.length).toBeGreaterThan(0);
      for (const value of [
        issued.access_token,
        issued.refresh_token,
        other.access_token,
        other.refresh_token,
        deps.keyring.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      ])
        expect(lines.join('')).not.toContain(value);
    } finally {
      await app.close();
    }
  });
}

it('[BR-ID-01][04 §6.1] 真实logout缺令牌10001、坏令牌10002、来源不符10403；拒绝无会话写入', async () => {
  const deps = fixture();
  const principal = await seed(deps.clock);
  const issued = await db.transaction().execute((trx) => createSession(trx, principal, deps));
  const before = await sessionRow(principal.app_id, issued.sid);
  const app = await buildApp(deps, []);
  try {
    await app.init();
    for (const [headers, code] of [
      [{ ...HEADERS }, 10001],
      [{ ...HEADERS, authorization: 'Bearer invalid' }, 10002],
      [{ ...HEADERS, 'x-app-id': 'other', authorization: `Bearer ${issued.access_token}` }, 10403],
    ] as const) {
      await rejected(await app.inject({ method: 'POST', url: '/v1/auth/logout', headers }), code);
      expect(await sessionRow(principal.app_id, issued.sid)).toEqual(before);
    }
    await rejected(
      await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: { 'content-type': 'application/json' },
        payload: '{"broken":',
      }),
      10001,
    );
  } finally {
    await app.close();
  }
});
