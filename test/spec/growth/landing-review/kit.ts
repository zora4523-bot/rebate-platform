// BR-INV-09 fixtures and observations; factories execute in test bodies, never setup hooks.
import { randomInt, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { PostgresQueryCompiler, sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import type { FirstAppLoginReviewDeps } from '../../../../apps/api/src/modules/growth/application/first-app-login-review.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const AT = '2026-10-18T03:04:05.678Z';
export const HASH = 'ab12'.repeat(16);
export const OTHER_HASH = 'cd34'.repeat(16);
export type Executor = Kysely<DB>;
type Growth =
  typeof import('../../../../apps/api/src/modules/growth/application/first-app-login-review.ts') &
    typeof import('../../../../apps/api/src/modules/growth/infra/relation-lock.ts');
type Reader =
  typeof import('../../../../apps/api/src/modules/identity/ports/invite-login-devices.ts');
type Risk =
  typeof import('../../../../apps/api/src/modules/risk/application/invite-relation-hits.ts');

export async function growth(): Promise<Growth> {
  return import(new URL('apps/api/src/modules/growth/index.ts', ROOT).href) as Promise<Growth>;
}
export async function seedUser(db: Executor, appId: string, phoneHmac: string | null = null) {
  const id = randomUUID();
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  await db
    .withSchema('app')
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname: 'fixture',
      avatar: 'https://example.invalid/avatar.png',
      invite_code: Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]!).join(''),
      attr_code: randomUUID(),
      level: 'L1',
      register_method: 'sms',
      status: 'normal',
      phone_hmac: phoneHmac,
    })
    .execute();
  return id;
}
export async function landing(db: Executor, appId: string, uid: string, parentId: string) {
  await db
    .withSchema('app')
    .updateTable('users')
    .set({
      parent_id: parentId,
      parent_bind_source: 'landing',
      parent_bound_at: new Date(AT),
      self_bind_used: true,
    })
    .where('app_id', '=', appId)
    .where('id', '=', uid)
    .execute();
}
export async function loginLog(db: Executor, appId: string, uid: string, hash: string) {
  await db
    .withSchema('app')
    .insertInto('login_logs')
    .values({
      app_id: appId,
      user_id: uid,
      device_id_hash: hash,
      method: 'sms',
      ip: '192.0.2.20',
      created_at: new Date(AT),
    })
    .execute();
}
export function user(db: Executor, appId: string, uid: string) {
  return db
    .withSchema('app')
    .selectFrom('users')
    .selectAll()
    .where('app_id', '=', appId)
    .where('id', '=', uid)
    .executeTakeFirstOrThrow();
}
export async function relationLogs(db: Executor, appId: string) {
  return (
    await sql<{
      app_id: string;
      user_id: string;
      from_parent_id: string | null;
      to_parent_id: string | null;
      source: string;
      operator: string;
      at: Date;
    }>`SELECT app_id, user_id, from_parent_id, to_parent_id, source, operator, at
    FROM app.relation_change_logs WHERE app_id = ${appId} ORDER BY id`.execute(db)
  ).rows;
}
export function hits(db: Executor, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('risk_hits')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}
export async function assertHit(
  db: Executor,
  appId: string,
  uid: string,
  parentId: string,
  hash: string,
  at: Date,
) {
  expect(await user(db, appId, uid)).toMatchObject({
    parent_id: null,
    parent_bind_source: null,
    parent_bound_at: null,
    self_bind_used: true,
  });
  expect(await relationLogs(db, appId)).toEqual([
    {
      app_id: appId,
      user_id: uid,
      from_parent_id: parentId,
      to_parent_id: null,
      source: 'risk_same_device',
      operator: 'system',
      at,
    },
  ]);
  expect(await hits(db, appId)).toEqual([
    expect.objectContaining({
      app_id: appId,
      user_id: uid,
      rule_id: 'inv_09_same_device',
      dimension: 'device_id_hash',
      value_hmac: hash,
      ref_type: 'invite_relation',
      ref_id: uid,
      created_at: at,
    }),
  ]);
}
export async function assertSilent(db: Executor, appId: string) {
  for (const table of ['inbox_messages', 'notify_logs'] as const) {
    expect(
      await db
        .withSchema('app')
        .selectFrom(table)
        .selectAll()
        .where('app_id', '=', appId)
        .execute(),
    ).toEqual([]);
  }
}
export async function fixture(base: Executor) {
  const statements: string[] = [];
  const db = base.withPlugin({
    transformQuery({ node, queryId }) {
      statements.push(new PostgresQueryCompiler().compileQuery(node, queryId).sql);
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const { FixedClock } = await import('../../../../apps/api/src/modules/platform/clock/index.ts');
  const clock = new FixedClock(AT);
  const appId = `review_${randomUUID()}`;
  const parentId = await seedUser(db, appId);
  const uid = await seedUser(db, appId);
  await landing(db, appId, uid, parentId);
  const id = (await import(new URL('apps/api/src/modules/identity/index.ts', ROOT).href)) as Reader;
  const risk = (await import(new URL('apps/api/src/modules/risk/index.ts', ROOT).href)) as Risk;
  const deps: FirstAppLoginReviewDeps = {
    clock,
    loginDevices: id.createInviteLoginDevicesReader(),
    hitWriter: risk.createInviteRelationHitWriter({ clock }),
  };
  const input = { app_id: appId, user_id: uid, device_id_hash: HASH };
  return {
    db,
    appId,
    uid,
    parentId,
    clock,
    deps,
    input,
    statements,
    async reviewer(overrides: Partial<FirstAppLoginReviewDeps> = {}) {
      return (await growth()).createFirstAppLoginReview({ ...deps, ...overrides });
    },
  };
}
