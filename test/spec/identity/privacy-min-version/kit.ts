import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import type * as Scope from '../../../../apps/api/src/modules/risk/application/minimum-version.ts';
import type * as Privacy from '../../../../apps/api/src/modules/identity/application/privacy-consent.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const NOW = '2026-10-17T02:00:00.000Z';
export const MIN_KEY = 'legal.privacy.min_version';

export async function user(db: Kysely<DB>, appId: string, uid = randomUUID()) {
  await db
    .withSchema('app')
    .insertInto('users')
    .values({
      id: uid,
      app_id: appId,
      register_method: 'sms',
      status: 'normal',
      nickname: '隐私测试用户',
      avatar: 'avatar:default',
      invite_code: randomBytes(6).toString('hex'),
      attr_code: randomBytes(8).toString('hex'),
      level: 'L1',
    })
    .execute();
  return uid;
}

export async function consent(
  db: Kysely<DB>,
  appId: string,
  uid: string,
  options: {
    accepted?: boolean;
    version?: number;
    at?: string;
    clientAt?: string;
    subject?: 'user' | 'device';
    device?: string;
    type?: 'privacy' | 'agreement';
  } = {},
) {
  const at = new Date(options.at ?? NOW);
  return db
    .withSchema('app')
    .insertInto('consent_records')
    .values({
      app_id: appId,
      user_id: uid,
      subject_type: options.subject ?? 'user',
      device_id: options.device ?? null,
      type: options.type ?? 'privacy',
      version: options.version ?? 2,
      accepted: options.accepted ?? true,
      channel: 'privacy_center',
      client_at: new Date(options.clientAt ?? options.at ?? NOW),
      server_at: at,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
}

export function request(
  appId: string,
  uid: string,
  method = 'GET',
  path = '/v1/me',
): Scope.MinimumVersionRequest {
  return {
    id: randomUUID(),
    method,
    routeOptions: { url: path },
    headers: { 'x-app-id': 'forged-app' },
    body: { app_id: 'forged-app', user_id: randomUUID(), accepted: true, version: 999 },
    principal: { app_id: appId, uid, sid: randomUUID(), device_id: randomUUID(), scp: 'full' },
  };
}

export function activate(checks: Privacy.PrivacyConsentChecks, input: Scope.MinimumVersionRequest) {
  return checks.guard.canActivate({ switchToHttp: () => ({ getRequest: () => input }) });
}

export function privacyError(trace: string) {
  return {
    status: 403,
    response: {
      code: 10004,
      msg: '请先阅读并同意相关授权',
      data: { consent_type: 'privacy' },
      trace_id: trace,
    },
  };
}

export async function noKey(db: Kysely<DB>, appId: string, key: string) {
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
