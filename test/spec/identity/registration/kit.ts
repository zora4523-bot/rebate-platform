// Test-owned database fixtures and crypto setup; no registration implementation in helpers.
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { expect } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
  openFieldCrypto,
  type FieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import {
  createRegistrationService,
  type RegistrationCommand,
  type RegistrationOptions,
  type RegistrationResult,
} from '../../../../apps/api/src/modules/identity/application/registration.ts';

export const WINDOW = 30 * 24 * 60 * 60 * 1000;
export const PHONE = '13800138000';
export const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

// The test-database helper is imported at run time (computed URL), like sms-codes/kit.ts: the
// count and sensitive-word unit tests share this kit and must not depend on @couli/db/testing
// (depcruise rule testcontainers-only-in-int-tests).
interface TestDatabase {
  urlFor(role: string): string;
  drop(): Promise<void>;
}
async function createTestDatabase(): Promise<TestDatabase> {
  const testing = (await import(
    new URL('../../../../packages/db/src/testing/index.ts', import.meta.url).href
  )) as { createTestDatabase(): Promise<TestDatabase> };
  return testing.createTestDatabase();
}

export interface Kit {
  database: TestDatabase;
  db: Kysely<DB>;
  crypto: FieldCrypto;
}
export async function openKit(): Promise<Kit> {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  const provider = new LocalKeyProvider(randomBytes(32));
  const crypto = await openFieldCrypto(await createWrappedKeyring(provider), provider);
  return { database, db, crypto };
}
export async function closeKit(kit: Kit | undefined): Promise<void> {
  if (!kit) return;
  try {
    await destroyDb(kit.db);
  } finally {
    await kit.database.drop();
  }
}
export async function context(kit: Kit) {
  const { rows } = await sql<{ now: Date }>`SELECT now() AS now`.execute(kit.db);
  const clock = new FixedClock(rows[0]!.now);
  const appId = `reg_${randomUUID().replaceAll('-', '')}`;
  const hash = randomBytes(32).toString('hex');
  const command: RegistrationCommand = {
    app_id: appId,
    phone: PHONE,
    register_method: 'sms',
    channel: 'test_channel',
    device_hash: hash,
    device_id: randomUUID(),
    client_ip: '192.0.2.19',
  };
  const lines: string[] = [];
  const values = new Map<string, unknown>();
  const options: RegistrationOptions = {
    clock,
    crypto: kit.crypto,
    config: {
      configValue: async (app, key) => {
        expect(app).toBe(appId);
        return values.has(key) ? { value: values.get(key), version: 1 } : null;
      },
    },
    logger: createRootLogger(
      { level: 'trace', entry: 'api', appEnv: 'test' },
      {
        write: (chunk: string) => void lines.push(chunk),
      },
    ),
    sensitiveWords: { matches: () => false },
  };
  return {
    appId,
    hash,
    command,
    clock,
    lines,
    values,
    options,
    register: (
      overrides: Partial<RegistrationCommand> = {},
      ports: Partial<RegistrationOptions> = {},
    ) => {
      // Called inside each test body, never a setup hook: NotImplemented must fail every test.
      const service = createRegistrationService({ ...options, ...ports });
      return kit.db
        .transaction()
        .execute((trx) => service.register(trx, { ...command, ...overrides }));
    },
  };
}
export type Context = Awaited<ReturnType<typeof context>>;
export function success(result: RegistrationResult) {
  expect(result).toMatchObject({ code: 0 });
  if (!('code' in result) || result.code !== 0) throw new Error('unreachable after assertion');
  return result;
}
export function assertPrivateWarnings(lines: readonly string[]) {
  const parsed = lines.map((line) => JSON.parse(line) as { level: number });
  expect(parsed.some((line) => line.level === 40)).toBe(true);
  expect(lines.join('')).not.toContain(PHONE);
  expect(lines.join('')).not.toContain(`+86${PHONE}`);
}
export async function sizes(db: Kysely<DB>, app: string) {
  const { rows } = await sql<{ users: number; registrations: number }>`
    SELECT (SELECT count(*)::int FROM app.users WHERE app_id = ${app}) AS users,
      (SELECT count(*)::int FROM app.device_registrations WHERE app_id = ${app}) AS registrations
  `.execute(db);
  return rows[0]!;
}
export async function user(db: Kysely<DB>, id: string) {
  return db
    .withSchema('app')
    .selectFrom('users')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}
export async function registrations(db: Kysely<DB>, app: string) {
  return db
    .withSchema('app')
    .selectFrom('device_registrations')
    .selectAll()
    .where('app_id', '=', app)
    .orderBy('user_id')
    .execute();
}
export async function seedUser(
  db: Kysely<DB> | Transaction<DB>,
  app: string,
  options: {
    hash?: string;
    method?: string;
    invite?: string;
    attr?: string;
    status?: string;
    phoneHmac?: string;
  } = {},
) {
  const id = randomUUID();
  const invite =
    options.invite ??
    Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]!).join('');
  await sql`INSERT INTO app.users
    (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, status, phone_hmac)
    VALUES (${id}, ${app}, 'fixture', 'fixture', ${invite},
      ${options.attr ?? randomBytes(4).toString('hex')}, 'L1', ${options.method ?? 'sms'},
      ${options.status ?? 'normal'}, ${options.phoneHmac ?? null})`.execute(db);
  if (options.hash !== undefined) {
    await sql`INSERT INTO app.device_registrations (app_id, device_hash, user_id, register_method)
      VALUES (${app}, ${options.hash}, ${id}, ${options.method ?? 'sms'})`.execute(db);
  }
  return id;
}
export async function merge(db: Kysely<DB>, app: string, source: string, target: string) {
  await db.transaction().execute(async (trx) => {
    await sql`UPDATE app.device_registrations SET merged_into_user_id = ${target}
      WHERE app_id = ${app} AND user_id = ${source}`.execute(trx);
    await sql`UPDATE app.users SET status = 'deleted', deleted_reason = 'merged'
      WHERE app_id = ${app} AND id = ${source}`.execute(trx);
  });
}
// New records keep database time; only the injected window endpoint moves.
export async function anchorAfterRecords(kit: Kit, ctx: Context, offset = 60_000) {
  const { rows } = await sql<{ latest: Date }>`SELECT max(created_at) AS latest
    FROM app.device_registrations WHERE app_id = ${ctx.appId}`.execute(kit.db);
  ctx.clock.set(new Date(rows[0]!.latest.getTime() + offset));
}
