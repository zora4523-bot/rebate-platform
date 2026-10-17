// Real PG via openSuite -> @couli/db/testing.createTestDatabase(), and real Redis.
// Factories under test are called inside test actions, never in setup hooks.
import { randomBytes, randomUUID } from 'node:crypto';
import { PostgresQueryCompiler, sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@couli/db';
import { expect } from 'vitest';
import type {
  InviteBindCommand,
  InviteBinderDeps,
  InviteBindingResult,
} from '../../../../apps/api/src/modules/growth/application/invite-binder.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import { openSuite, closeSuite } from '../../risk/device-register/kit.ts';
import { keys, withRedis } from '../../risk/rate-limit/kit.ts';

export { openSuite, closeSuite };
export type Suite = Awaited<ReturnType<typeof openSuite>>;
export const ROOT = new URL('../../../../', import.meta.url);
export const NOW = '2031-05-06T09:00:00.000Z';
export const CODE = 'K7Q2MZ';
export const OTHER_CODE = 'R8W3NX';
export const OWN_CODE = 'A2B3C4';
export const DEVICE_CONTEXT = 'login_logs.device_id';

type Growth = typeof import('../../../../apps/api/src/modules/growth/application/invite-binder.ts');
type Identity = {
  createInviteBackfillActivityReader: typeof import('../../../../apps/api/src/modules/identity/infra/me-reads.ts').createInviteBackfillActivityReader;
  createInviteLoginDevicesReader: typeof import('../../../../apps/api/src/modules/identity/ports/invite-login-devices.ts').createInviteLoginDevicesReader;
  PHONE_BLIND_INDEX_CONTEXT: string;
};
type Risk = {
  createRiskStateService: typeof import('../../../../apps/api/src/modules/risk/application/risk-state.ts').createRiskStateService;
};
export async function growth(): Promise<Growth> {
  return import(new URL('apps/api/src/modules/growth/index.ts', ROOT).href) as Promise<Growth>;
}
export async function identity(): Promise<Identity> {
  return import(new URL('apps/api/src/modules/identity/index.ts', ROOT).href) as Promise<Identity>;
}

export async function withFixture(suite: Suite, run: (f: Fixture) => Promise<void>) {
  await withRedis(suite.server, async (base) => {
    base.clock.set(NOW);
    const queries: { kind: string; sql: string }[] = [];
    const db = suite.kit.db.withPlugin({
      transformQuery({ node, queryId }) {
        queries.push({
          kind: node.kind,
          sql: new PostgresQueryCompiler().compileQuery(node, queryId).sql,
        });
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const values = new Map<string, unknown>();
    const app = base.app;
    const userId = await seedUser(db, app, {
      invite: OWN_CODE,
      phoneHmac: randomBytes(32).toString('hex'),
    });
    const parentId = await seedUser(db, app, {
      invite: CODE,
      phoneHmac: randomBytes(32).toString('hex'),
    });
    await db
      .withSchema('app')
      .updateTable('users')
      .set({
        created_at: new Date('2031-05-05T09:00:00.000Z'),
        updated_at: new Date(NOW),
      })
      .where('app_id', '=', app)
      .execute();
    const id = await identity();
    const risk = (await import(new URL('apps/api/src/modules/risk/index.ts', ROOT).href)) as Risk;
    const deps: InviteBinderDeps = {
      clock: base.clock,
      logger: base.options.logger,
      crypto: suite.kit.crypto,
      redis: base.handles[0]!,
      config: {
        configValue: async (_app, key) =>
          values.has(key) ? { value: values.get(key), version: 1 } : null,
      },
      activity: (trx) => id.createInviteBackfillActivityReader(trx),
      loginDevices: {
        read: (trx, subject) => id.createInviteLoginDevicesReader().read(trx, subject),
      },
      readRisk: (trx, subject) =>
        risk
          .createRiskStateService({
            db: trx,
            clock: base.clock,
            events: {
              publish: async () => {
                throw new Error('unexpected event in invite read');
              },
            },
          })
          .readRiskState(subject, { fresh: true }),
    };
    const command: InviteBindCommand = {
      channel: 'backfill',
      app_id: app,
      user_id: userId,
      invite_code: CODE,
      device_id: randomUUID(),
    };
    const f: Fixture = {
      ...base,
      db,
      app,
      userId,
      parentId,
      deps,
      command,
      values,
      queries,
      async binder(overrides = {}) {
        return (await growth()).createInviteBinder({ ...deps, ...overrides });
      },
      async bind(input = {}, overrides = {}) {
        const binder = await f.binder(overrides);
        return db.transaction().execute((trx) => binder.bind(trx, { ...command, ...input }));
      },
      row: (uid = userId) => row(db, app, uid),
      logs: (uid = userId) => logs(db, app, uid),
      patch: async (data, uid = userId) => {
        await db
          .withSchema('app')
          .updateTable('users')
          .set(data)
          .where('app_id', '=', app)
          .where('id', '=', uid)
          .execute();
      },
    };
    try {
      await run(f);
    } finally {
      const owned = await keys(base.raw, `*${app}*`);
      if (owned.length) await base.raw.call('DEL', ...owned);
    }
  });
}

type Base = Parameters<Parameters<typeof withRedis>[1]>[0];
type User = Awaited<ReturnType<typeof row>>;
export interface Fixture extends Base {
  db: Kysely<DB>;
  userId: string;
  parentId: string;
  deps: InviteBinderDeps;
  command: InviteBindCommand;
  values: Map<string, unknown>;
  queries: { kind: string; sql: string }[];
  binder(overrides?: Partial<InviteBinderDeps>): Promise<ReturnType<Growth['createInviteBinder']>>;
  bind(
    input?: Partial<InviteBindCommand>,
    overrides?: Partial<InviteBinderDeps>,
  ): Promise<InviteBindingResult>;
  row(uid?: string): Promise<User>;
  logs(uid?: string): Promise<RelationLog[]>;
  patch(data: Partial<User>, uid?: string): Promise<void>;
}
export async function row(db: Kysely<DB>, app: string, uid: string) {
  return db
    .withSchema('app')
    .selectFrom('users')
    .selectAll()
    .where('app_id', '=', app)
    .where('id', '=', uid)
    .executeTakeFirstOrThrow();
}
export interface RelationLog {
  app_id: string;
  user_id: string;
  from_parent_id: string | null;
  to_parent_id: string | null;
  source: string;
  operator: string;
  reason: string | null;
  at: Date;
}
export async function logs(db: Kysely<DB>, app: string, uid: string): Promise<RelationLog[]> {
  const result = await sql<RelationLog>`SELECT app_id, user_id, from_parent_id, to_parent_id,
    source, operator, reason, at FROM app.relation_change_logs
    WHERE app_id = ${app} AND user_id = ${uid} ORDER BY id`.execute(db);
  return result.rows;
}
export async function failed(
  f: Fixture,
  code: number,
  command: Partial<InviteBindCommand> = {},
  deps: Partial<InviteBinderDeps> = {},
) {
  const before = await f.row();
  const start = f.queries.length;
  const result = await f.bind(command, deps);
  expect(result).toMatchObject({ result: 'failed', code });
  expect(
    f.queries.slice(start).filter((q) => /^\s*(?:insert|update|delete)\b/i.test(q.sql)),
  ).toEqual([]);
  expect(await f.row()).toEqual(before);
  expect(await f.logs()).toEqual([]);
  return result;
}
export async function bound(f: Fixture, command: Partial<InviteBindCommand> = {}) {
  const before = await f.row();
  const at = f.clock.now();
  const result = await f.bind(command);
  expect(result).toEqual({ result: 'bound', parent_id: f.parentId, bound_at: at });
  expect(await f.row()).toEqual({
    ...before,
    parent_id: f.parentId,
    parent_bind_source: command.channel ?? 'backfill',
    parent_bound_at: at,
    self_bind_used: true,
    updated_at: at,
    row_version: before.row_version + 1,
  });
  expect(await f.logs()).toEqual([
    {
      app_id: f.app,
      user_id: f.userId,
      from_parent_id: null,
      to_parent_id: f.parentId,
      source: command.channel ?? 'backfill',
      operator: `user:${f.userId}`,
      reason: null,
      at,
    },
  ]);
}
export async function loginLog(
  db: Kysely<DB> | Transaction<DB>,
  app: string,
  uid: string,
  hash: string,
  at = new Date('2030-01-01T00:00:00.000Z'),
) {
  await db
    .withSchema('app')
    .insertInto('login_logs')
    .values({
      app_id: app,
      user_id: uid,
      device_id_hash: hash,
      ip: '192.0.2.44',
      method: 'sms',
      created_at: at,
    })
    .execute();
}
export async function order(f: Fixture, status = 'VOID') {
  const oid = randomUUID();
  const sub = randomUUID();
  const at = new Date(NOW);
  await f.db
    .withSchema('app')
    .insertInto('order_keys')
    .values({
      platform: 'taobao',
      sub_order_id: sub,
      order_id: oid,
      app_id: f.app,
      attr_at: at,
    })
    .execute();
  await f.db
    .withSchema('app')
    .insertInto('orders')
    .values({
      order_id: oid,
      app_id: f.app,
      platform: 'taobao',
      sub_order_id: sub,
      raw_item_id: 'fixture',
      user_id: f.userId,
      buy_type: 'self',
      platform_status: 'INVALID',
      rebate_status: status,
      attr_at: at,
    })
    .execute();
}
export async function child(f: Fixture, parent = f.userId, invite?: string, status = 'normal') {
  const uid = await seedUser(f.db, f.app, {
    ...(invite === undefined ? {} : { invite }),
    status,
    phoneHmac: randomBytes(32).toString('hex'),
  });
  await f.patch(
    { parent_id: parent, parent_bind_source: 'register', parent_bound_at: new Date(NOW) },
    uid,
  );
  return uid;
}
export async function riskState(f: Fixture, state: 'banned' | 'appealing' | 'frozen') {
  await f.db
    .withSchema('app')
    .insertInto('user_risk_state')
    .values({
      app_id: f.app,
      user_id: f.parentId,
      state,
      reason: 'fixture',
      reason_category: 'other',
      frozen_until: state === 'frozen' ? new Date('2031-06-01T00:00:00Z') : null,
      changed_by: 'fixture',
      changed_at: new Date(NOW),
      created_at: new Date(NOW),
      updated_at: new Date(NOW),
    })
    .execute();
}
