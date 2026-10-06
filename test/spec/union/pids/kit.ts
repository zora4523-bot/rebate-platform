// B1-19b: BR-ATTR-02/08/28 and task adjudications, SPEC_REF b9f54fe.
// Business-role DB fixtures only. Verifier doubles represent the combined F1-06b check,
// not a TOTP-only check. F1-06b owns real code generation, replay and account authentication.
// Factory is called in each test body, before rejection assertions: every skeleton case is red.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Insertable, type Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import {
  createUnionPidService,
  type PidPlatform,
  type PidServiceDeps,
  type WriteContext,
} from '../../../../apps/api/src/modules/union/pids/service.ts';

export const START = '2031-05-06T07:08:09.000Z';
export const EVIDENCE = 'fixtures/hjy/confirmation.png';
export const PLATFORMS = ['taobao', 'jd', 'pdd'] as const;

export function harness(db: Kysely<DB>) {
  const clock = new FixedClock(START);
  const appId = `pids-${randomUUID()}`;
  const adminId = randomUUID();
  const auth: WriteContext = { appId, adminId, code: '123456', ip: '192.0.2.10' };
  const verify = vi.fn<PidServiceDeps['superVerifier']['verify']>(async (input) => ({
    appId: input.appId,
    adminId: input.adminId.toLowerCase(),
  }));
  const append = vi.fn(
    async (
      trx: Kysely<DB>,
      input: Parameters<ReturnType<PidServiceDeps['auditWriter']>['append']>[0],
    ) => {
      await trx
        .insertInto('audit_logs')
        .values({
          app_id: input.appId,
          admin_id: input.actor,
          action: input.action,
          target: input.target,
          before: input.before === null ? null : sql`${JSON.stringify(input.before)}::jsonb`,
          after: input.after === null ? null : sql`${JSON.stringify(input.after)}::jsonb`,
          ip: input.ip,
          at: clock.now(),
        })
        .execute();
    },
  );
  const deps: PidServiceDeps = {
    db,
    clock,
    superVerifier: { verify },
    auditWriter: (trx) => ({ append: (input) => append(trx, input) }),
  };
  const service = createUnionPidService(deps);
  return { db, clock, appId, adminId, auth, verify, append, deps, service };
}

export type Harness = ReturnType<typeof harness>;

export async function seedAdmin(h: Harness) {
  await h.db
    .insertInto('admin_users')
    .values({
      id: h.adminId,
      app_id: h.appId,
      login_name: h.adminId,
      password_hash: 'fixture-not-a-password-hash',
      is_super: true,
      status: 'active',
    })
    .execute();
}

export async function seedAccount(
  h: Harness,
  values: Partial<Insertable<DB['union_accounts']>> = {},
) {
  return h.db
    .insertInto('union_accounts')
    .values({
      id: randomUUID(),
      app_id: h.appId,
      platform: 'jd',
      account_name: 'synthetic account',
      status: 'pending',
      auth_status: 'active',
      sync_start_at: null,
      created_at: h.clock.now(),
      updated_at: h.clock.now(),
      ...values,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function seedPid(h: Harness, values: Partial<Insertable<DB['union_pids']>> = {}) {
  const platform = values.platform ?? 'jd';
  const accountId = values.union_account_id ?? (await seedAccount(h, { platform })).id;
  return h.db
    .insertInto('union_pids')
    .values({
      id: randomUUID(),
      app_id: h.appId,
      platform,
      union_account_id: accountId,
      site_id: platform === 'taobao' ? '200' : null,
      pid: `synthetic-${randomUUID()}`,
      pid_scene: 'self_buy',
      status: 'pending',
      hjy_ignore_confirmed_at: h.clock.now(),
      hjy_ignore_evidence_path: EVIDENCE,
      created_at: h.clock.now(),
      updated_at: h.clock.now(),
      ...values,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function registration(h: Harness, accountId: string, platform: PidPlatform = 'jd') {
  const suffix = String(Number.parseInt(randomUUID().slice(0, 8), 16));
  return {
    ...h.auth,
    platform,
    unionAccountId: accountId,
    siteId: platform === 'taobao' ? '200' : null,
    pid:
      platform === 'taobao'
        ? `mm_100_200_${suffix}`
        : platform === 'pdd'
          ? `100_${suffix}`
          : suffix,
    pidScene: 'self_buy' as const,
  };
}

export function accountRegistration(h: Harness, platform: PidPlatform = 'jd') {
  return {
    ...h.auth,
    platform,
    accountName: 'synthetic account',
    authStatus: 'active' as const,
    authExpiresAt: null,
  };
}

export async function state(h: Harness) {
  return {
    accounts: await h.db
      .selectFrom('union_accounts')
      .selectAll()
      .where('app_id', '=', h.appId)
      .orderBy('id')
      .execute(),
    pids: await h.db
      .selectFrom('union_pids')
      .selectAll()
      .where('app_id', '=', h.appId)
      .orderBy('id')
      .execute(),
    audits: await audits(h),
  };
}

export function audits(h: Harness) {
  return h.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', h.appId)
    .orderBy('id')
    .execute();
}

export function storedPid(h: Harness, id: string) {
  return h.db
    .selectFrom('union_pids')
    .selectAll()
    .where('app_id', '=', h.appId)
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

export async function rejectedUnchanged(h: Harness, command: () => Promise<unknown>) {
  const before = await state(h);
  await expect(command()).rejects.toThrow();
  expect(await state(h)).toEqual(before);
}

export function whitelist(h: Harness, row: Awaited<ReturnType<typeof seedPid>>) {
  return {
    appId: h.appId,
    platform: row.platform as PidPlatform,
    unionAccountId: row.union_account_id,
    siteId: row.site_id,
    pid: row.pid,
  };
}
