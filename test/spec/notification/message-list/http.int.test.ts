// Real API assembly and authenticated HTTP; business-role database through @couli/db/testing.
import { createHash, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { bindPushTokensForSession } from '../../../../apps/api/src/modules/notification/application/session-bindings.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import {
  createValidatorCompiler,
  routeSchemaOf,
  validationErrorEnvelope,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { contract, ROOT, type Response } from '../../risk/signature/kit.ts';
import { HEADERS, fixture as identityFixture } from '../../identity/token/kit.ts';
import {
  NOW,
  TIMEOUT,
  expectSchema,
  messagesOf,
  newAppId,
  seedMessage,
  seedUser,
  type Operation,
} from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db !== undefined) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: unknown;
  }): Promise<Response>;
}

async function fixture() {
  const deps = identityFixture();
  deps.clock.set(NOW);
  const login = async () => {
    const device_id = randomUUID();
    await db
      .withSchema('app')
      .insertInto('devices')
      .values({
        id: device_id,
        app_id: 'couli',
        device_hash: createHash('sha256').update(device_id).digest('hex'),
        id_source: 'idfv',
        install_secret_cipher: Buffer.from('unused-by-inbox-tests'),
        platform: 'ios',
        app_version: '2.0.0',
        last_seen_at: deps.clock.now(),
        created_at: deps.clock.now(),
      })
      .execute();
    const uid = await seedUser(db, 'couli');
    const issued = await db
      .transaction()
      .execute((trx) =>
        createSession(
          trx,
          { uid, app_id: 'couli', device_id, scp: 'full' },
          deps,
          (same, session) =>
            bindPushTokensForSession(
              same,
              { app_id: 'couli', user_id: uid, device_id, sid: session.sid },
              deps.clock,
            ),
        ),
      );
    return { uid, device_id, ...issued };
  };
  const me = await login();
  const someone = await login();
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: 'api', overrides: object): Promise<App>;
  };
  const app = await createHttpApp('api', {
    config: loadConfig({
      APP_ENV: 'test',
      JWT_KEY_ID: deps.keyring.kid,
      JWT_PRIVATE_KEY_PEM: deps.keyring.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    }),
    clock: deps.clock,
    logger: createRootLogger({ entry: 'api', appEnv: 'test', level: 'silent' }),
    dbHandles: { db, dbRead: null, close: async () => undefined },
    startQueue: false,
  });
  const request = (url: string, body?: unknown, caller = me) =>
    app.inject({
      method: body === undefined ? 'GET' : 'POST',
      url,
      headers: {
        ...HEADERS,
        'x-channel': 'appstore',
        'x-device-id': caller.device_id,
        authorization: `Bearer ${caller.access_token}`,
      },
      ...(body === undefined ? {} : { payload: body }),
    });
  return {
    app,
    request,
    clock: deps.clock,
    me,
    someone,
    owner: { app_id: 'couli', user_id: me.uid },
  };
}

async function success(response: Response, operation: Operation) {
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, msg: '' });
  await expectSchema(operation, '200', response.json());
}

async function cursorError(response: Response) {
  expect(response.statusCode, response.body).toBe(400);
  expect(response.json()).toMatchObject({ code: 20001, data: { fields: ['cursor'] } });
  await expectSchema('listMessages', '4XX', response.json());
}

it(
  '[AC-B1-12k#9][BR-ID-10] HTTP列表分页与详情字段一致、未读数只含本人；静态unread-count和read路由可达',
  async () => {
    const f = await fixture();
    try {
      const older = await seedMessage(db, f.owner);
      const newer = await seedMessage(db, f.owner, {
        created_at: '2026-10-03T02:00:00.000Z',
        route: { route: 'WithdrawRecords', params: {} },
      });
      const theirs = await seedMessage(db, { app_id: 'couli', user_id: f.someone.uid });
      const otherApp = newAppId('http');
      const abroad = await seedMessage(db, {
        app_id: otherApp,
        user_id: await seedUser(db, otherApp),
      });
      const before = await messagesOf(db, 'couli');
      const foreignBefore = await messagesOf(db, otherApp);
      await f.app.init();
      const first = await f.request('/v1/messages?limit=1');
      await success(first, 'listMessages');
      const data = first.json<Schema<'InboxMessageListResponse'>>().data;
      expect(data.items.map((item) => item.message_id)).toEqual([newer]);
      expect(data.next_cursor).toEqual(expect.any(String));
      const detail = await f.request(`/v1/messages/${newer}`);
      expect(detail.statusCode).toBe(200);
      expect(data.items[0]).toEqual(detail.json<Schema<'InboxMessageResponse'>>().data);
      const second = await f.request(
        `/v1/messages?limit=1&cursor=${encodeURIComponent(data.next_cursor!)}`,
      );
      await success(second, 'listMessages');
      expect(
        second.json<Schema<'InboxMessageListResponse'>>().data.items.map((item) => item.message_id),
      ).toEqual([older]);
      expect(second.json<Schema<'InboxMessageListResponse'>>().data.next_cursor).toBeNull();
      const count = await f.request('/v1/messages/unread-count');
      await success(count, 'getUnreadMessageCount');
      expect(count.json()).toMatchObject({ data: { unread_count: 2 } });
      expect(await messagesOf(db, 'couli')).toEqual(before);
      const marked = await f.request('/v1/messages/read', {
        message_ids: [newer, newer, theirs, abroad, randomUUID()],
      });
      await success(marked, 'markMessagesRead');
      expect(marked.json()).toMatchObject({ data: { marked_count: 1, unread_count: 1 } });
      const after = await messagesOf(db, 'couli');
      expect(after).toEqual(
        before.map((row) =>
          row.message_id === newer
            ? {
                ...row,
                read_at: f.clock.now(),
                updated_at: f.clock.now(),
                row_version: row.row_version + 1,
              }
            : row,
        ),
      );
      expect(await messagesOf(db, otherApp)).toEqual(foreignBefore);
      const remaining = await f.request('/v1/messages/unread-count');
      await success(remaining, 'getUnreadMessageCount');
      expect(remaining.json()).toMatchObject({ data: { unread_count: 1 } });
      const all = await f.request('/v1/messages/read', { all: true });
      await success(all, 'markMessagesRead');
      expect(all.json()).toMatchObject({ data: { marked_count: 1, unread_count: 0 } });
      const repeated = await f.request('/v1/messages/read', { all: true });
      await success(repeated, 'markMessagesRead');
      expect(repeated.json()).toMatchObject({ data: { marked_count: 0, unread_count: 0 } });
      const finalCount = await f.request('/v1/messages/unread-count');
      await success(finalCount, 'getUnreadMessageCount');
      expect(finalCount.json()).toMatchObject({ data: { unread_count: 0 } });
    } finally {
      await f.app.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-12k#10][BR-ID-10] 不透明游标可继续翻页，任意字符串、截断游标和另一账号的游标均20001/cursor',
  async () => {
    const f = await fixture();
    try {
      await seedMessage(db, f.owner);
      await seedMessage(db, f.owner);
      await seedMessage(db, { app_id: 'couli', user_id: f.someone.uid });
      const before = await messagesOf(db, 'couli');
      await f.app.init();
      const first = await f.request('/v1/messages?limit=1');
      await success(first, 'listMessages');
      const cursor = first.json<Schema<'InboxMessageListResponse'>>().data.next_cursor;
      expect(cursor).toEqual(expect.any(String));
      expect(cursor).not.toBe('');
      await success(
        await f.request(`/v1/messages?limit=1&cursor=${encodeURIComponent(cursor!)}`),
        'listMessages',
      );
      for (const invalid of [
        'arbitrary-b112k-cursor',
        cursor!.slice(0, Math.floor(cursor!.length / 2)),
      ]) {
        await cursorError(await f.request(`/v1/messages?cursor=${encodeURIComponent(invalid)}`));
      }
      await cursorError(
        await f.request(`/v1/messages?cursor=${encodeURIComponent(cursor!)}`, undefined, f.someone),
      );
      expect(await messagesOf(db, 'couli')).toEqual(before);
    } finally {
      await f.app.close();
    }
  },
  TIMEOUT,
);

const invalidBodies = [
  { label: '两种同时带', value: { message_ids: ['id'], all: true } },
  { label: '两种都不带', value: {} },
  { label: '空列表', value: { message_ids: [] } },
  { label: '超过100', value: { message_ids: Array.from({ length: 101 }, (_, i) => `id-${i}`) } },
  { label: 'all=false', value: { all: false } },
  { label: 'all字符串不转换', value: { all: 'true' } },
  { label: 'id为空', value: { message_ids: [''] } },
  { label: 'id过长', value: { message_ids: ['a'.repeat(65)] } },
  { label: 'id非字符串', value: { message_ids: [123] } },
  { label: 'id为null', value: { message_ids: [null] } },
  { label: '伪造user_id', value: { all: true, user_id: 'other-user' } },
  { label: '伪造app_id', value: { all: true, app_id: 'other_app' } },
];

it.each(invalidBodies)(
  '[AC-B1-12k#11] $label：路由按契约拒绝20001，fields与平台一致，消息不变',
  async ({ value }) => {
    const f = await fixture();
    try {
      await seedMessage(db, f.owner);
      const before = await messagesOf(db, 'couli');
      await f.app.init();
      // Confirms the write route exists before testing rejection of its body.
      const probe = await f.request('/v1/messages/read', { message_ids: [randomUUID()] });
      await success(probe, 'markMessagesRead');
      const op = (await contract()).paths['/v1/messages/read']!.post!;
      const route = routeSchemaOf(op as Parameters<typeof routeSchemaOf>[0]);
      const check = createValidatorCompiler()({ schema: route.body!, httpPart: 'body' });
      expect(check(structuredClone(value))).toBe(false);
      const expected = validationErrorEnvelope(
        { code: 'FST_ERR_VALIDATION', validation: check.errors, validationContext: 'body' },
        'fixture-trace',
      );
      expect(expected?.body.data.fields.length).toBeGreaterThan(0);
      const response = await f.request('/v1/messages/read', value);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({
        code: 20001,
        data: { fields: expected!.body.data.fields },
      });
      await expectSchema('markMessagesRead', '4XX', response.json());
      expect(await messagesOf(db, 'couli')).toEqual(before);
    } finally {
      await f.app.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-12k#12] message_ids的1与100边界合法，100个重复id只标一次，合法长度非UUID静默跳过',
  async () => {
    const f = await fixture();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 101; i += 1) ids.push(await seedMessage(db, f.owner));
      await f.app.init();
      const single = await f.request('/v1/messages/read', { message_ids: [ids[0]] });
      await success(single, 'markMessagesRead');
      expect(single.json()).toMatchObject({ data: { marked_count: 1, unread_count: 100 } });
      const hundred = await f.request('/v1/messages/read', { message_ids: ids.slice(1) });
      await success(hundred, 'markMessagesRead');
      expect(hundred.json()).toMatchObject({ data: { marked_count: 100, unread_count: 0 } });
      const fresh = await seedMessage(db, f.owner);
      const duplicates = await f.request('/v1/messages/read', {
        message_ids: Array.from({ length: 100 }, () => fresh),
      });
      await success(duplicates, 'markMessagesRead');
      expect(duplicates.json()).toMatchObject({ data: { marked_count: 1, unread_count: 0 } });
      // Id schema constrains type/length, not a UUID pattern; these are unknown ids, not 20001.
      const unknown = await f.request('/v1/messages/read', {
        message_ids: ['non-uuid-id', 'a'.repeat(64)],
      });
      await success(unknown, 'markMessagesRead');
      expect(unknown.json()).toMatchObject({ data: { marked_count: 0, unread_count: 0 } });
    } finally {
      await f.app.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-12k#13] 列表limit默认20且1/50可用；越界、非整数、非数字及过长cursor返回20001相应字段',
  async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 51; i += 1) await seedMessage(db, f.owner);
      const before = await messagesOf(db, 'couli');
      await f.app.init();
      for (const [query, size] of [
        ['', 20],
        ['?limit=1', 1],
        ['?limit=50', 50],
      ] as const) {
        const response = await f.request(`/v1/messages${query}`);
        await success(response, 'listMessages');
        expect(response.json<Schema<'InboxMessageListResponse'>>().data.items).toHaveLength(size);
      }
      for (const value of ['0', '51', '-1', '1.5', 'abc']) {
        const response = await f.request(`/v1/messages?limit=${value}`);
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json()).toMatchObject({ code: 20001, data: { fields: ['limit'] } });
        await expectSchema('listMessages', '4XX', response.json());
      }
      await cursorError(await f.request(`/v1/messages?cursor=${'a'.repeat(513)}`));
      expect(await messagesOf(db, 'couli')).toEqual(before);
    } finally {
      await f.app.close();
    }
  },
  TIMEOUT,
);
