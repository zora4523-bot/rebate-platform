import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import {
  createLinkRegistration,
  type LinkingOptions,
} from '../../../../apps/api/src/modules/linking/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { caller, input, pid, seed, START, USER_A } from '../register/kit.ts';

// Local shape until the orchestrator generates DB types from the migration. No generated file edits.
export type CodeDB = Omit<DB, 'links'> & { links: DB['links'] & { lk: string | null } };
export interface CodeOptions {
  readonly linkCode?: () => string;
  readonly logger?: { error(fields: Readonly<Record<string, unknown>>, message?: string): void };
}
export interface CodeReader {
  linkByCode(input: { appId: string; platform: string; lk: string }): Promise<{
    link_id: string;
    user_id: string | null;
    scene: string;
    agent_session_id: string | null;
  } | null>;
}

export async function capture<T>(work: () => T | Promise<T>) {
  try {
    return { ok: true as const, value: await work() };
  } catch (error) {
    return { ok: false as const, error };
  }
}

export async function built<T>(work: () => T | Promise<T>): Promise<T> {
  const result = await capture(work);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw result.error;
  return result.value;
}

interface DatabaseHandle {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export function databaseFixture(factory: () => Promise<DatabaseHandle>) {
  let database: DatabaseHandle | undefined;
  let db: Kysely<DB> | undefined;
  beforeAll(async () => {
    database = await factory();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
    await seed(db);
  }, 180_000);
  afterAll(async () => {
    try {
      if (db) await destroyDb(db);
    } finally {
      await database?.drop();
    }
  }, 30_000);
  return () => {
    expect(db).toBeDefined();
    return db!;
  };
}

export async function codeDb(db: Kysely<DB>): Promise<Kysely<CodeDB>> {
  const result = await sql<{
    is_nullable: string;
    column_default: string | null;
    data_type: string;
  }>`
    SELECT is_nullable, column_default, data_type FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'links' AND column_name = 'lk'
  `.execute(db);
  expect(result.rows).toEqual([{ is_nullable: 'YES', column_default: null, data_type: 'text' }]);
  return db as unknown as Kysely<CodeDB>;
}

export function registration(db: Kysely<DB>, platform: 'jd' | 'pdd' | 'taobao' = 'jd') {
  const clock = new FixedClock(START);
  const settings = new Map<string, DB['config_items']['value']>([
    [`attr.click_code.${platform}`, true],
  ]);
  const linkCode = vi.fn(() => 'a1b2c3');
  const error = vi.fn();
  const configValue = vi.fn(async (_app: string, key: string) =>
    settings.has(key) ? { value: settings.get(key) ?? null, version: 1 } : null,
  );
  const options: LinkingOptions & CodeOptions = {
    db,
    clock,
    callerContext: { current: async () => caller() },
    attrCodes: { attrCode: async () => 'demo0001' },
    config: { configValue },
    pids: { getActivePid: async (query) => pid(query) },
    context: { scene: 'agent' },
    linkCode,
    logger: { error },
  };
  const original = input();
  const request = {
    ...original,
    ref: { ...original.ref, platform, productKey: `${platform}:${randomUUID()}` },
    item: { ...original.item, platform },
  };
  const register = () => createLinkRegistration(options).register(request);
  return { options, request, register, settings, linkCode, error, configValue, clock };
}

export async function row(db: Kysely<CodeDB>, linkId: string) {
  return db.selectFrom('links').selectAll().where('link_id', '=', linkId).executeTakeFirstOrThrow();
}

export async function seedLink(
  db: Kysely<CodeDB>,
  lk: string | null,
  patch: Partial<{ app_id: string; platform: string; user_id: string | null; scene: string }> = {},
) {
  const now = new FixedClock(START).now();
  return db
    .insertInto('links')
    .values({
      link_id: randomUUID(),
      app_id: 'register-app',
      platform: 'jd',
      user_id: USER_A,
      scene: 'detail',
      created_at: now,
      updated_at: now,
      expire_at: new FixedClock('2031-05-07T07:08:09.000Z').now(),
      lk,
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
