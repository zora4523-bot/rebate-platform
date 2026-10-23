// B1-22c / BR-ID-24, SPEC_REF eabcf00. Synthetic OAuth port, never a platform recording.
// B1-22a is parallel: this test-local type describes its agreed schema, not a migration.
// Every test calls the factory before touching the new columns/table, so the skeleton fails
// with NotImplemented even before B1-22a is merged. The container runner owns DB setup.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Generated, type Insertable, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
  openFieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  createSiteReauth,
  type SiteOAuthProvider,
  type SiteReauthOptions,
  type UnionAuditInput,
} from '../../../../apps/api/src/modules/union/index.ts';

export const START = '2032-02-28T23:56:00.000Z';
export const PROVIDER_EXPIRY = new Date('2032-07-01T12:34:56.000Z');
export const ACCESS = 'fixture-access-secret';
export const REFRESH = 'fixture-refresh-secret';
export const CODE = 'fixture-once-only-code';
export const TTL = 10 * 60 * 1000;

interface Session {
  id: string;
  app_id: string;
  union_account_id: string;
  state_hash: Buffer;
  created_by: string;
  expires_at: Date;
  used_at: Date | null;
  status: 'pending' | 'succeeded' | 'failed' | 'expired';
  error: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

type ReauthDB = Omit<DB, 'union_accounts' | 'admin_union_auth_sessions'> & {
  union_accounts: DB['union_accounts'] & { auth_expires_estimated: Generated<boolean> };
  admin_union_auth_sessions: Session;
};

/** The one-shot database a test file creates (createTestDatabase from @couli/db/testing). */
export interface TestDatabase {
  urlFor(role: string): string;
  drop(): Promise<void>;
}

/** The int test passes createTestDatabase (testcontainers stay in *.int.test.ts, depcruise). */
export function databaseFixture(create: () => Promise<TestDatabase>) {
  let database: TestDatabase | undefined;
  let db: Kysely<DB>;
  beforeAll(async () => {
    // createTestDatabase reads TEST_PG_ADMIN_URL; business operations use couli_app.
    database = await create();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 6 });
  });
  afterAll(async () => {
    if (db) await destroyDb(db);
    if (database) await database.drop();
  });
  return () => db;
}

export async function harness(db: Kysely<DB>, overrides: Partial<SiteReauthOptions> = {}) {
  const clock = new FixedClock(START);
  const appId = `reauth-${randomUUID()}`;
  const adminId = randomUUID();
  const provider = new LocalKeyProvider(randomBytes(32));
  const crypto = await openFieldCrypto(await createWrappedKeyring(provider), provider);
  const authorizeUrl = vi.fn<SiteOAuthProvider['authorizeUrl']>(
    async (input) => `https://oauth.example.invalid/authorize?state=${input.state}`,
  );
  const exchange = vi.fn<SiteOAuthProvider['exchange']>(async () => ({
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt: PROVIDER_EXPIRY,
  }));
  const configValue = vi.fn<SiteReauthOptions['config']['configValue']>(async () => null);
  const entropy = vi.fn((n: number) => randomBytes(n));
  const append = vi.fn(async (trx: Kysely<DB>, input: UnionAuditInput) => {
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
  });
  const options: SiteReauthOptions = {
    db,
    clock,
    crypto,
    auditWriter: (trx) => ({ append: (input) => append(trx, input) }),
    config: { configValue },
    oauth: { taobao: { authorizeUrl, exchange } },
    randomBytes: entropy,
    ...overrides,
  };
  const service = createSiteReauth(options);
  const store = db as unknown as Kysely<ReauthDB>;
  return {
    db,
    store,
    clock,
    appId,
    adminId,
    crypto,
    authorizeUrl,
    exchange,
    configValue,
    entropy,
    append,
    options,
    service,
  };
}

export type Harness = Awaited<ReturnType<typeof harness>>;

export async function seed(
  h: Harness,
  values: Partial<Insertable<ReauthDB['union_accounts']>> = {},
) {
  await h.db
    .insertInto('admin_users')
    .values({
      id: h.adminId,
      app_id: h.appId,
      login_name: h.adminId,
      password_hash: 'fixture-not-a-password',
      is_super: true,
      status: 'active',
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  return h.store
    .insertInto('union_accounts')
    .values({
      id: randomUUID(),
      app_id: h.appId,
      platform: 'taobao',
      account_name: 'synthetic site',
      status: 'active',
      auth_status: 'expired',
      auth_expires_at: new Date('2032-01-01T00:00:00Z'),
      auth_expires_estimated: true,
      auth_renewed_at: null,
      auth_renewed_by: null,
      alert_stage: 'expired',
      last_probe_at: new Date('2032-02-28T09:00:00Z'),
      last_probe_ok: false,
      last_probe_error: 'synthetic-auth-invalid',
      row_version: 7,
      created_at: h.clock.now(),
      updated_at: h.clock.now(),
      ...values,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function startInput(h: Harness, unionAccountId: string) {
  return {
    appId: h.appId,
    unionAccountId,
    adminId: h.adminId,
    reason: 'operator requested renewal',
    ip: '192.0.2.7',
  };
}

export async function start(h: Harness, unionAccountId: string) {
  const result = await h.service.start(startInput(h, unionAccountId));
  const call = h.authorizeUrl.mock.calls.at(-1);
  expect(call).toBeDefined();
  return { ...result, state: call![0].state };
}

export async function seedCredential(h: Harness, unionAccountId: string) {
  return h.db
    .insertInto('union_credentials')
    .values({
      id: randomUUID(),
      app_id: h.appId,
      union_account_id: unionAccountId,
      access_token_cipher: Buffer.from(h.crypto.encrypt('old-access', 'union_credentials.access')),
      refresh_token_cipher: Buffer.from(
        h.crypto.encrypt('old-refresh', 'union_credentials.refresh'),
      ),
      expires_at: new Date('2032-01-01T00:00:00Z'),
      is_current: true,
      created_at: h.clock.now(),
      updated_at: h.clock.now(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function session(h: Harness, id: string) {
  return h.store
    .selectFrom('admin_union_auth_sessions')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

export function account(h: Harness, id: string) {
  return h.store
    .selectFrom('union_accounts')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

export function credentials(h: Harness) {
  return h.db
    .selectFrom('union_credentials')
    .selectAll()
    .where('app_id', '=', h.appId)
    .orderBy('id')
    .execute();
}

export function audits(h: Harness) {
  return h.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', h.appId)
    .orderBy('id')
    .execute();
}

export async function snapshot(h: Harness) {
  return {
    accounts: await h.store
      .selectFrom('union_accounts')
      .selectAll()
      .where('app_id', '=', h.appId)
      .orderBy('id')
      .execute(),
    sessions: await h.store
      .selectFrom('admin_union_auth_sessions')
      .selectAll()
      .where('app_id', '=', h.appId)
      .orderBy('id')
      .execute(),
    credentials: await credentials(h),
    audits: await audits(h),
  };
}

export function hash(state: string) {
  return createHash('sha256').update(state).digest();
}

export function expectNoSecrets(value: unknown, secrets: string[]) {
  // audit_logs.id is int8, which @couli/db returns as BigInt (ADR-0001 §4.2 #3); JSON.stringify
  // cannot serialize BigInt, so write it as its decimal string. Assertions unchanged.
  const serialized = JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
    // pg bytea/Buffer JSON representation must not hide a plaintext from the assertion.
    expect(serialized).not.toContain(JSON.stringify([...Buffer.from(secret)]));
    expect(serialized).not.toContain(Buffer.from(secret).toString('hex'));
  }
}
