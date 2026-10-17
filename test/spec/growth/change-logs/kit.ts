// B1-11b rule-test helpers: fixtures and raw reads only, no growth implementation.
// The two log tables (migration 0041, B1-11a) are read with raw SQL so this kit compiles before
// they enter the generated DB types. Every read of a log table runs only after a call into the
// growth module has succeeded, so on the NotImplemented skeleton each test fails on that call.
// The test-database helper is not imported here (only *.int.test.ts files may import it).
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import type {
  LevelChangeInput,
  RelationChangeInput,
  UserLevel,
} from '../../../../apps/api/src/modules/growth/index.ts';

const { createRootLogger } =
  await import('../../../../apps/api/src/modules/platform/logging/logger.ts');

export type Executor = Kysely<DB> | Transaction<DB>;

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function newAppId(): string {
  return `growth_${randomUUID().replaceAll('-', '')}`;
}

/** Instants of the BR-CALC-12 细则 examples (Beijing time). */
export function instant(iso: string): Date {
  return new Date(iso);
}

export function shift(at: Date, ms: number): Date {
  return new Date(at.getTime() + ms);
}

/** Runs `run` so that a synchronous throw and a rejection both become a rejection. */
export function attempt<T>(run: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(run);
}

/** A users row of the fixture (level L1 unless given, no parent). */
export async function seedUser(db: Executor, app: string, level = 'L1'): Promise<string> {
  const id = randomUUID();
  const invite = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]!).join('');
  await sql`INSERT INTO app.users
    (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, status)
    VALUES (${id}, ${app}, 'fixture', 'fixture', ${invite}, ${randomBytes(4).toString('hex')},
      ${level}, 'sms', 'normal')`.execute(db);
  return id;
}

export interface UserSnapshot {
  level: string;
  parent_id: string | null;
  parent_bind_source: string | null;
  parent_bound_at: Date | null;
  row_version: number;
  updated_at: Date;
}
export async function userSnapshot(db: Executor, id: string): Promise<UserSnapshot> {
  const { rows } = await sql<UserSnapshot>`SELECT level, parent_id, parent_bind_source,
      parent_bound_at, row_version, updated_at
    FROM app.users WHERE id = ${id}`.execute(db);
  if (rows.length !== 1) throw new Error('fixture user not found');
  return rows[0]!;
}
export async function userCreatedAt(db: Executor, id: string): Promise<Date> {
  const { rows } = await sql<{ created_at: Date }>`SELECT created_at FROM app.users
    WHERE id = ${id}`.execute(db);
  if (rows.length !== 1) throw new Error('user not found');
  return rows[0]!.created_at;
}
export async function userCount(db: Executor, app: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM app.users
    WHERE app_id = ${app}`.execute(db);
  return rows[0]!.n;
}

export interface LevelLogRow {
  id: string;
  app_id: string;
  user_id: string;
  from_level: string | null;
  to_level: string;
  source: string;
  operator: string;
  reason: string | null;
  effective_at: Date;
  created_at: Date;
}
export async function levelLogs(db: Executor, app: string): Promise<LevelLogRow[]> {
  const { rows } = await sql<LevelLogRow>`SELECT id::text AS id, app_id, user_id::text AS user_id,
      from_level, to_level, source, operator, reason, effective_at, created_at
    FROM app.level_change_logs WHERE app_id = ${app} ORDER BY id`.execute(db);
  return rows;
}

export interface RelationLogRow {
  id: string;
  app_id: string;
  user_id: string;
  from_parent_id: string | null;
  to_parent_id: string | null;
  source: string;
  operator: string;
  reason: string | null;
  at: Date;
  created_at: Date;
}
export async function relationLogs(db: Executor, app: string): Promise<RelationLogRow[]> {
  const { rows } = await sql<RelationLogRow>`SELECT id::text AS id, app_id,
      user_id::text AS user_id, from_parent_id::text AS from_parent_id,
      to_parent_id::text AS to_parent_id, source, operator, reason, at, created_at
    FROM app.relation_change_logs WHERE app_id = ${app} ORDER BY id`.execute(db);
  return rows;
}

export class Rollback extends Error {
  constructor() {
    super('test rollback');
    this.name = 'Rollback';
  }
}
/** Runs `body` in a transaction that is always rolled back; any other error propagates. */
export async function rolledBack(
  db: Kysely<DB>,
  body: (trx: Transaction<DB>) => Promise<void>,
): Promise<void> {
  try {
    await db.transaction().execute(async (trx) => {
      await body(trx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

export function registerLevel(
  app: string,
  user: string,
  level: UserLevel,
  effectiveAt: Date,
): LevelChangeInput {
  return {
    app_id: app,
    user_id: user,
    from_level: null,
    to_level: level,
    source: 'register',
    operator: 'system',
    reason: null,
    effective_at: effectiveAt,
  };
}
export function adminLevel(
  app: string,
  user: string,
  from: UserLevel,
  to: UserLevel,
  effectiveAt: Date,
): LevelChangeInput {
  return {
    app_id: app,
    user_id: user,
    from_level: from,
    to_level: to,
    source: 'admin',
    operator: `admin:${randomUUID()}`,
    reason: 'manual review',
    effective_at: effectiveAt,
  };
}
export function bindParent(
  app: string,
  user: string,
  from: string | null,
  to: string | null,
  at: Date,
): RelationChangeInput {
  if (from === null) {
    return {
      app_id: app,
      user_id: user,
      from_parent_id: null,
      to_parent_id: to,
      source: 'landing',
      operator: `user:${user}`,
      reason: null,
      at,
    };
  }
  return {
    app_id: app,
    user_id: user,
    from_parent_id: from,
    to_parent_id: to,
    source: 'admin',
    operator: `admin:${randomUUID()}`,
    reason: 'manual relation change',
    at,
  };
}

export interface LogLine {
  level: number;
  msg?: string;
  [key: string]: unknown;
}
/** A real pino root logger whose lines are kept for assertions. */
export function capturedLogger() {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (chunk: string) => void lines.push(chunk) },
  );
  return {
    logger,
    entries: (): LogLine[] => lines.map((line) => JSON.parse(line) as LogLine),
  };
}
/** Warnings growth_level_log_missing about one account. */
export function missingWarnings(entries: readonly LogLine[], app: string, user: string): LogLine[] {
  return entries.filter(
    (line) =>
      line.msg === 'growth_level_log_missing' &&
      line.level === 40 &&
      line['app_id'] === app &&
      line['user_id'] === user,
  );
}
