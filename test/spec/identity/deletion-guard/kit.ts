// B1-15e §9.2: stage ⑥ (10007) rule tests. Synthetic fixtures only (direct deletion_requests rows
// that satisfy 0059's pair and window checks); databases are acquired only by *.int.test.ts.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { expect } from 'vitest';
import type * as Guard from '../../../../apps/api/src/modules/identity/application/deletion-guard.ts';
import type * as Scope from '../../../../apps/api/src/modules/risk/application/minimum-version.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const NOW = '2026-10-17T02:00:00.000Z';
export const MSG = '账号注销处理中';
export type Executor = Kysely<DB> | Transaction<DB>;
export type RequestStatus = 'cooling' | 'processing' | 'done' | 'cancelled';

/** The skeleton's public entry points, through identity's only exit (runtime import). */
export async function identity(): Promise<typeof Guard> {
  return import(new URL('apps/api/src/modules/identity/index.ts', ROOT).href) as Promise<
    typeof Guard
  >;
}

export async function user(db: Executor, appId: string, status = 'normal') {
  const id = randomUUID();
  await db
    .withSchema('app')
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      register_method: 'sms',
      status,
      nickname: '注销守卫用户',
      avatar: 'avatar:default',
      invite_code: randomBytes(6).toString('hex'),
      attr_code: randomBytes(8).toString('hex'),
      level: 'L1',
    })
    .execute();
  return id;
}

/** A deletion request applied at `at` (cooling window 7×24 h); done rows end at cooling_until. */
export async function deletion(
  db: Executor,
  appId: string,
  userId: string,
  status: RequestStatus,
  at: Date | string = NOW,
) {
  const id = randomUUID();
  const applied = new Date(at);
  const until = new Date(applied.getTime() + 7 * 86_400_000);
  await db
    .withSchema('app')
    .insertInto('deletion_requests')
    .values({
      id,
      app_id: appId,
      user_id: userId,
      status,
      apply_at: applied,
      cooling_until: until,
      cancelled_at: status === 'cancelled' ? applied : null,
      cancel_reason: status === 'cancelled' ? 'user' : null,
      processed_at: status === 'done' ? until : null,
      balance_snapshot_fen: 0n,
      created_at: applied,
      updated_at: status === 'done' ? until : applied,
    })
    .execute();
  return id;
}

export async function cancel(db: Executor, id: string, at: Date | string = NOW) {
  const when = new Date(at);
  await db
    .withSchema('app')
    .updateTable('deletion_requests')
    .set({ status: 'cancelled', cancelled_at: when, cancel_reason: 'user', updated_at: when })
    .where('id', '=', id)
    .execute();
}

export async function userStatus(db: Executor, appId: string, userId: string, status: string) {
  await db
    .withSchema('app')
    .updateTable('users')
    .set({ status })
    .where('app_id', '=', appId)
    .where('id', '=', userId)
    .execute();
}

/** A request as the guard sees it after ② (principal from the verified token). */
export function request(
  appId: string,
  uid: string | null,
  method = 'PATCH',
  path = '/v1/me',
  forged: { appId: string; uid: string } = { appId: 'forged_app', uid: randomUUID() },
): Scope.MinimumVersionRequest {
  return {
    id: randomUUID(),
    method,
    routeOptions: { url: path },
    headers: { 'x-app-id': forged.appId, 'x-user-id': forged.uid },
    body: { app_id: forged.appId, user_id: forged.uid, uid: forged.uid },
    ...(uid === null
      ? {}
      : {
          principal: {
            app_id: appId,
            uid,
            sid: randomUUID(),
            device_id: randomUUID(),
            scp: 'full' as const,
          },
        }),
  };
}

export function activate(checks: Guard.DeletionStageChecks, input: Scope.MinimumVersionRequest) {
  return checks.guard.canActivate({ switchToHttp: () => ({ getRequest: () => input }) });
}

/** The refusal thrown by both paths: an HttpException carrying the contract envelope. */
export function refusal(trace: string, stage: 'cooling' | 'processing') {
  return {
    status: 403,
    response: { code: 10007, msg: MSG, data: { stage }, trace_id: trace },
  };
}

export const UNAVAILABLE = { code: 50001, statusCode: 500 };

/** Every statement compiled on the returned executor (and transactions started on it). */
export function observe(db: Kysely<DB>) {
  const statements: string[] = [];
  const executor = db.withPlugin({
    transformQuery({ node, queryId }) {
      statements.push(db.getExecutor().compileQuery(node, queryId).sql);
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  return { executor, statements };
}

/** An executor whose every statement fails. */
export function failing(db: Kysely<DB>, message = 'fixture database failed') {
  return db.withPlugin({
    transformQuery() {
      throw new Error(message);
    },
    async transformResult({ result }) {
      return result;
    },
  });
}

export async function noKey(db: Executor, appId: string, key: string) {
  expect(
    await db
      .withSchema('app')
      .selectFrom('idempotency_keys')
      .select('id')
      .where('app_id', '=', appId)
      .where('key', '=', key)
      .execute(),
  ).toEqual([]);
}
