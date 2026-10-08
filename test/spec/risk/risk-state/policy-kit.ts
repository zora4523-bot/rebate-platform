import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createRiskStateService,
  type RiskStateRequest,
  type RiskStateSnapshot,
} from '../../../../apps/api/src/modules/risk/index.ts';

export const NORMAL: RiskStateSnapshot = {
  state: 'normal',
  reason_category: null,
  frozen_until: null,
};
export const BANNED: RiskStateSnapshot = {
  state: 'banned',
  reason_category: 'other',
  frozen_until: null,
};
export const SUBJECT = { app_id: 'couli', user_id: '019a0000-0000-7000-8000-000000000010' };
export const WHITELIST = [
  { method: 'GET', path: '/v1/me' },
  { method: 'GET', path: '/v1/withdrawals' },
  { method: 'GET', path: '/v1/withdrawals/:withdrawal_id' },
  { method: 'POST', path: '/v1/auth/logout' },
  { method: 'POST', path: '/v1/auth/refresh' },
  {
    method: 'POST',
    path: '/v1/auth/oauth-attempts',
    body: { provider: 'wechat', purpose: 'step_up', action: 'account_deletion' },
  },
  {
    method: 'POST',
    path: '/v1/auth/step-up',
    body: { action: 'account_deletion', code: '123456' },
  },
  { method: 'POST', path: '/v1/me/deletion' },
  { method: 'GET', path: '/v1/me/deletion' },
  { method: 'POST', path: '/v1/me/deletion/cancel' },
  {
    method: 'POST',
    path: '/v1/idempotency-keys/abandon',
    body: { action: 'withdraw', idempotency_key: 'abandon_fixture' },
  },
  {
    method: 'POST',
    path: '/v1/me/appeals',
    body: { target_type: 'account', content: '请核查账号状态。' },
  },
  { method: 'GET', path: '/v1/me/appeals' },
] as const;

export interface Route {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}
export function request(route: Route, authenticated = true): RiskStateRequest {
  return {
    id: randomUUID(),
    method: route.method,
    routeOptions: { url: route.path },
    headers: {
      'x-app-id': 'couli',
      'x-platform': 'ios',
      'x-channel': 'appstore',
      'x-app-version': '2.0.0',
    },
    body: route.body,
    ...(authenticated
      ? {
          principal: {
            uid: SUBJECT.user_id,
            app_id: SUBJECT.app_id,
            sid: 'fixture_sid',
            device_id: randomUUID(),
            scp: 'full' as const,
          },
        }
      : {}),
  };
}

/** Scripted PG transport only: real Kysely and the production state service issue all reads.
 * Real SQL scoping, persistence, CAS and event atomicity are covered in service.int.test.ts. */
export function policyFixture(
  snapshot: RiskStateSnapshot | null = BANNED,
  previous: 'banned' | 'frozen' = 'banned',
) {
  const clock = new FixedClock('2026-10-08T04:00:00Z');
  let current = snapshot;
  let failure: Error | undefined;
  const statements: string[] = [];
  const reads: string[] = [];
  const client = {
    release() {},
    async query(text: string) {
      statements.push(text);
      let rows: unknown[] = [];
      if (/^select\b/i.test(text) && text.includes('user_risk_state')) {
        reads.push(text);
        if (failure !== undefined) throw failure;
        rows =
          current === null
            ? []
            : [
                {
                  ...SUBJECT,
                  ...current,
                  row_version: 0,
                  reason: 'private rule details',
                  prev_risk_state: previous,
                },
              ];
      } else if (/^select\b/i.test(text) && text.includes('appeals')) {
        rows = [
          {
            ...SUBJECT,
            id: randomUUID(),
            target_type: 'account',
            target_id: SUBJECT.user_id,
            status: 'processing',
            prev_risk_state: previous,
          },
        ];
      }
      return { command: 'SELECT', rowCount: rows.length, rows };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  }).withSchema('app');
  const events = { publish: vi.fn(async () => ({ eventId: randomUUID(), duplicate: false })) };
  // Lazy construction inside every test, not at collection or in a suite hook.
  return {
    db,
    clock,
    reads,
    statements,
    events,
    service: () => createRiskStateService({ db, clock, events }),
    change: (value: RiskStateSnapshot | null) => {
      current = value;
    },
    failReads: (error: Error) => {
      failure = error;
    },
  };
}
