import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it, vi } from 'vitest';
import {
  createDefaultRealnameStatusReader,
  createIdentityLevelChecks,
  identityLevelRefusal,
  type RealnameStatusReader,
} from './identity-level.ts';

const PAYOUT = '/v1/me/payout-account';
const principal = {
  app_id: 'couli',
  uid: '0199a3b4-5c6d-7e8f-9a0b-000000000001',
  sid: '0199a3b4-5c6d-7e8f-9a0b-000000000002',
  device_id: '0199a3b4-5c6d-7e8f-9a0b-000000000003',
  scp: 'full' as const,
};

// A scripted driver: answers the users read with the given rows, no PG connection.
function scriptedDb(rows: unknown[]) {
  const queries: string[] = [];
  const client = {
    release: () => undefined,
    async query(text: string) {
      queries.push(text);
      return { command: 'SELECT', rowCount: rows.length, rows };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  });
  return { db, queries };
}

function context(method: string, url: string, withPrincipal = true) {
  const request = {
    id: 'trace',
    method,
    headers: {},
    routeOptions: { url },
    ...(withPrincipal ? { principal } : {}),
  };
  return { switchToHttp: () => ({ getRequest: () => request }) };
}

it('[BR-ID-01] phone before realname; only phone / realname levels are judged', () => {
  expect(
    identityLevelRefusal({ required: 'phone', phoneBound: false, realnameStatus: 'verified' }),
  ).toBe(10005);
  expect(
    identityLevelRefusal({ required: 'realname', phoneBound: false, realnameStatus: 'verified' }),
  ).toBe(10005);
  expect(
    identityLevelRefusal({ required: 'realname', phoneBound: true, realnameStatus: 'failed' }),
  ).toBe(30304);
  expect(
    identityLevelRefusal({ required: 'realname', phoneBound: true, realnameStatus: 'verified' }),
  ).toBeNull();
  expect(
    identityLevelRefusal({ required: 'admin', phoneBound: false, realnameStatus: 'none' }),
  ).toBeNull();
});

it('[BR-ID-01] the guard judges a realname GET from the database: no row → 10005, bound → port decides', async () => {
  const read = vi.fn<RealnameStatusReader['read']>(async () => 'none');
  const missing = scriptedDb([]);
  await expect(
    createIdentityLevelChecks({ db: missing.db, realname: { read } }).guard.canActivate(
      context('GET', PAYOUT),
    ),
  ).rejects.toMatchObject({ code: 10005, statusCode: 403 });
  expect(read).not.toHaveBeenCalled();
  const bound = scriptedDb([{ phone_hmac: 'a'.repeat(64) }]);
  await expect(
    createIdentityLevelChecks({ db: bound.db, realname: { read } }).guard.canActivate(
      context('GET', PAYOUT),
    ),
  ).rejects.toMatchObject({ code: 30304, statusCode: 422 });
  read.mockResolvedValueOnce('verified');
  await expect(
    createIdentityLevelChecks({ db: bound.db, realname: { read } }).guard.canActivate(
      context('GET', PAYOUT),
    ),
  ).resolves.toBe(true);
  expect(bound.queries).toHaveLength(2);
  await missing.db.destroy();
  await bound.db.destroy();
});

it('[BR-ID-01] the guard fails closed: no database → 50001, no principal → 10005', async () => {
  const read = vi.fn<RealnameStatusReader['read']>(async () => 'verified');
  const checks = createIdentityLevelChecks({ db: null, realname: { read } });
  await expect(checks.guard.canActivate(context('GET', PAYOUT))).rejects.toMatchObject({
    code: 50001,
    statusCode: 500,
  });
  await expect(checks.guard.canActivate(context('GET', PAYOUT, false))).rejects.toMatchObject({
    code: 10005,
  });
});

it('[BR-ID-01] skipped: idempotent, agent, login-level and unknown routes; post-miss outside HTTP', async () => {
  const read = vi.fn<RealnameStatusReader['read']>(async () => 'verified');
  const checks = createIdentityLevelChecks({ db: null, realname: { read } });
  for (const [method, url] of [
    ['PUT', PAYOUT],
    ['GET', '/v1/me'],
    ['POST', '/v1/agent/sessions'],
    ['GET', '/nowhere'],
  ] as const) {
    await expect(checks.guard.canActivate(context(method, url))).resolves.toBe(true);
  }
  await expect(
    checks.postMiss({
      appId: 'couli',
      actor: { userId: principal.uid, deviceId: null, phoneHmac: null },
      method: 'PUT',
      path: PAYOUT,
      key: 'k',
      body: {},
      traceId: 't',
    }),
  ).resolves.toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});

it('[BR-ID-01] the default real-name reader reads none without touching the handle', async () => {
  const handle = {} as Kysely<DB>;
  await expect(
    createDefaultRealnameStatusReader().read(handle, { app_id: 'couli', user_id: principal.uid }),
  ).resolves.toBe('none');
});
