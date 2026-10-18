// B2-03o / BR-CALC-22: storage only. Report keys below are synthetic fixture data,
// not a report contract. Sample selection, calculation and publication belong to services.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export const TIMEOUT = 60_000;
export const TABLE = 'commission_rule_trials';
export const ROLES = ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint'] as const;
export type Role = (typeof ROLES)[number];
export type Row = Record<string, unknown>;
export type Connection = Kysely<DB>;
export interface OneShotDatabase {
  urlFor(role: Role): string;
  drop(): Promise<void>;
}
export interface Harness {
  database: OneShotDatabase;
  app: Connection;
  roles: Record<Role, Connection>;
}

export const SHAPE = {
  trial_id: 'uuid',
  app_id: 'text',
  rule_version_id: 'uuid',
  base_version_id: 'uuid',
  sample_from: 'timestamptz',
  sample_to: 'timestamptz',
  sample_count: 'int4',
  sample_hash: 'text',
  report: 'jsonb',
  created_by: 'uuid',
  created_at: 'timestamptz',
} as const;

export async function open(create: () => Promise<OneShotDatabase>): Promise<Harness> {
  const database = await create();
  const roles = Object.fromEntries(
    ROLES.map((role) => [role, createDb({ connectionString: database.urlFor(role), max: 2 })]),
  ) as Record<Role, Connection>;
  return { database, app: roles.couli_app, roles };
}

export async function close(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await Promise.all(Object.values(h.roles).map((db) => destroyDb(db)));
  await h.database.drop();
}

export async function columns(db: Connection) {
  return (
    await sql<{
      name: string;
      type: string;
      nullable: boolean;
      default_expr: string | null;
    }>`SELECT a.attname::text AS name, t.typname::text AS type,
        NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS default_expr
      FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = to_regclass('app.commission_rule_trials')
        AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`.execute(db)
  ).rows;
}

// Per-case assertion, before any fixture SQL: an absent migration is an assertion red,
// never an undefined_table/undefined_column error or a beforeAll failure.
export async function ready(db: Connection): Promise<void> {
  const found = await sql<{ name: string | null }>`
    SELECT to_regclass('app.commission_rule_trials')::text AS name`.execute(db);
  expect(found.rows).toEqual([{ name: 'app.commission_rule_trials' }]);
  expect((await columns(db)).map(({ name }) => name)).toEqual(
    expect.arrayContaining(Object.keys(SHAPE)),
  );
}

export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string' || !['23502', '23503', '23505', '23514', '42501'].includes(code)) {
      throw error;
    }
    return code;
  }
}

export async function insert(db: Connection, row: Row, table = TABLE): Promise<void> {
  await sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(Object.keys(row).map((name) => sql.ref(name)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
}

export async function fixture(db: Connection): Promise<Row> {
  const appId = `b203o-${randomUUID()}`;
  const actor = randomUUID();
  const base = randomUUID();
  const draft = randomUUID();
  await insert(
    db,
    {
      id: actor,
      app_id: appId,
      login_name: `trial-${actor}`,
      password_hash: 'synthetic-not-a-password',
      is_super: false,
      status: 'active',
    },
    'admin_users',
  );
  for (const [id, status] of [
    [base, 'published'],
    [draft, 'draft'],
  ] as const) {
    await insert(
      db,
      {
        rule_version_id: id,
        app_id: appId,
        status,
        base_version_id: status === 'draft' ? base : null,
        drafter_id: actor,
        effective_from: status === 'published' ? new Date('2032-06-01T00:00:00+08:00') : null,
        publisher_id: status === 'published' ? actor : null,
        published_at: status === 'published' ? new Date('2032-06-01T00:00:00+08:00') : null,
      },
      'commission_rule_versions',
    );
  }
  return {
    trial_id: randomUUID(),
    app_id: appId,
    rule_version_id: draft,
    base_version_id: base,
    sample_from: new Date('2032-06-08T10:00:00+08:00'),
    sample_to: new Date('2032-06-15T10:00:00+08:00'),
    sample_count: 2,
    sample_hash: 'd'.repeat(64),
    report: JSON.stringify({
      platforms: [
        {
          platform: 'taobao',
          current: {
            reserve_bp: 1300,
            reserve_fen: 130,
            own_fen: 400,
            direct_fen: 100,
            indirect_fen: 0,
            platform_retain_fen: 370,
          },
          draft: {
            reserve_bp: 1500,
            reserve_fen: 150,
            own_fen: 350,
            direct_fen: 100,
            indirect_fen: 50,
            platform_retain_fen: 350,
          },
        },
      ],
    }),
    created_by: actor,
    created_at: new Date('2032-06-15T10:00:01+08:00'),
  };
}

export async function stored(db: Connection, id: unknown): Promise<Row[]> {
  return (
    await sql<Row>`SELECT * FROM app.commission_rule_trials
    WHERE trial_id = ${id}`.execute(db)
  ).rows;
}
