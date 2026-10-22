// B3-09d §9: BR-AI-05 / BR-AI-08. Expectations are the task's finalized schema,
// not values inferred from the migration. Every case checks new tables before DML,
// so a missing migration is an assertion failure, including the old-table regression case.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  columns,
  connect,
  foreignKeys,
  insertRow,
  requireTable,
  shape,
  sqlState,
  uniqueKeys,
} from '../linking-bindings/kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 3 });
  connect(app);
});

afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
});

type Row = Record<string, unknown>;
const AT = new Date('2026-10-21T08:00:00Z');
const TABLES = ['agent_result_deliveries', 'agent_clarify_asks', 'agent_result_chains'] as const;
type Table = (typeof TABLES)[number];
const CHECK = '23514';
const UNIQUE = '23505';
const FK = '23503';
const DENIED = '42501';
const OK = 'no error';

// contracts/enums/platform.yaml: platform (tmall is not a separate platform).
const PLATFORMS = [
  'taobao',
  'jd',
  'pdd',
  'meituan',
  'vip',
  'douyin',
  'eleme',
  'kuaishou',
  'suning',
];
const SHAPES: Record<Table, Record<string, string>> = {
  agent_result_deliveries: {
    app_id: 'text',
    session_id: 'uuid',
    run_id: 'uuid',
    result_set_id: 'uuid',
    position: 'int4',
    card_id: 'text',
    product_key: 'text',
    platform: 'text',
    final_price_fen: 'int8',
    card: 'jsonb',
    created_at: 'timestamptz',
  },
  agent_clarify_asks: {
    app_id: 'text',
    session_id: 'uuid',
    chain_id: 'text',
    slot: 'text',
    created_at: 'timestamptz',
  },
  agent_result_chains: {
    app_id: 'text',
    session_id: 'uuid',
    seq: 'int4',
    chain_id: 'text',
    status: 'text',
    conditions: 'jsonb?',
    created_at: 'timestamptz',
  },
};
const PRIMARY_KEYS: Record<Table, string[]> = {
  agent_result_deliveries: ['app_id', 'session_id', 'card_id'],
  agent_clarify_asks: ['app_id', 'session_id', 'chain_id', 'slot'],
  agent_result_chains: ['app_id', 'session_id', 'seq'],
};

function insertStatement(table: string, row: Row) {
  const names = Object.keys(row);
  return sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))})`;
}

async function insert(table: string, row: Row, db = app): Promise<Row> {
  await requireTable(table);
  await insertStatement(table, row).execute(db);
  return row;
}

async function session(appId = 'synthetic-agent-results'): Promise<Row> {
  await requireTable('agent_sessions');
  const deviceId = randomUUID();
  await insertRow('devices', {
    id: deviceId,
    app_id: appId,
    user_id: null,
    install_secret_cipher: Buffer.from('synthetic-agent-results-secret'),
    last_seen_at: AT,
  });
  return insert('agent_sessions', {
    id: randomUUID(),
    app_id: appId,
    user_id: null,
    device_id: deviceId,
    started_at: AT,
    last_active_at: AT,
  });
}

async function run(owner: Row): Promise<Row> {
  return insert('agent_runs', {
    id: randomUUID(),
    app_id: owner['app_id'],
    session_id: owner['id'],
    accepted_at: AT,
    quota_subjects: ['synthetic-device', 'synthetic-ip'],
    prompt_version: 'synthetic@1',
    user_text: 'synthetic product request',
  });
}

async function resultSet(parent: Row): Promise<Row> {
  return insert('agent_result_sets', {
    id: randomUUID(),
    app_id: parent['app_id'],
    run_id: parent['id'],
    conditions: '{}',
  });
}

// JSON strings are explicit: SQL NULL and the JSON literal null are different cases.
async function fixture(table: Table, owner?: Row): Promise<Row> {
  await requireTable(table);
  const parent = owner ?? (await session());
  const common = { app_id: parent['app_id'], session_id: parent['id'], created_at: AT };
  if (table === 'agent_clarify_asks') {
    return { ...common, chain_id: 'synthetic-chain', slot: 'price' };
  }
  if (table === 'agent_result_chains') {
    return {
      ...common,
      seq: 1,
      chain_id: 'synthetic-chain',
      status: 'has_products',
      conditions: JSON.stringify({ chain_id: 'synthetic-chain', q: 'synthetic product' }),
    };
  }
  const source = await run(parent);
  const set = await resultSet(source);
  return {
    ...common,
    run_id: source['id'],
    result_set_id: set['id'],
    position: 1,
    card_id: 'c1',
    product_key: 'jd:synthetic-product-1',
    platform: 'jd',
    final_price_fen: 0n,
    card: JSON.stringify({ title: 'synthetic product', url: 'https://example.invalid/product' }),
  };
}

for (const table of TABLES) {
  it(`[AC-B3-09d#1][BR-AI-05][BR-AI-08] ${table} has exactly the prescribed columns, nullability and defaults`, async () => {
    await requireTable(table);
    const actual = await columns(table);
    expect(actual.map((column) => column.name).sort()).toEqual(Object.keys(SHAPES[table]).sort());
    for (const [name, spec] of Object.entries(SHAPES[table])) {
      await shape(table, name, spec.replace(/\?$/, ''), spec.endsWith('?'));
      expect(actual.find((column) => column.name === name)?.hasDefault, name).toBe(
        name === 'created_at',
      );
    }
    const defaults = await sql<{ name: string; expression: string | null }>`
      SELECT a.attname AS name, pg_get_expr(d.adbin, d.adrelid) AS expression
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = to_regclass(${`app.${table}`}) AND a.attnum > 0 AND NOT a.attisdropped
    `.execute(app);
    expect(defaults.rows).toHaveLength(Object.keys(SHAPES[table]).length);
    for (const { name, expression } of defaults.rows) {
      expect(expression ?? '', name).not.toMatch(/uuidv7\s*\(/i);
      if (name === 'created_at') expect(expression).toBe('now()');
      else expect(expression, name).toBeNull();
    }
  });

  it(`[AC-B3-09d#2][BR-AI-05][BR-AI-08] ${table} has the ordered composite primary key and required indexes`, async () => {
    await requireTable(table);
    const primary = await sql<{ names: string[] }>`SELECT ARRAY(
      SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord
    ) AS names FROM pg_constraint c
    WHERE c.conrelid = to_regclass(${`app.${table}`}) AND c.contype = 'p'`.execute(app);
    expect(primary.rows).toEqual([{ names: PRIMARY_KEYS[table] }]);
    const indexes = await sql<{ names: string[] }>`SELECT ARRAY(
      SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
      WHERE k.ord <= i.indnkeyatts ORDER BY k.ord
    ) AS names FROM pg_index i WHERE i.indrelid = to_regclass(${`app.${table}`})
      AND i.indisvalid AND i.indisready AND i.indpred IS NULL`.execute(app);
    expect(indexes.rows).toContainEqual({ names: ['app_id', 'created_at'] });
    if (table === 'agent_result_deliveries') {
      expect(indexes.rows).toContainEqual({ names: ['app_id', 'run_id', 'result_set_id'] });
    }
  });

  it(`[AC-B3-09d#3][BR-AI-05][BR-AI-08] ${table} rejects SQL NULL in every required column`, async () => {
    const row = await fixture(table);
    for (const [name, spec] of Object.entries(SHAPES[table])) {
      if (!spec.endsWith('?')) {
        expect(await sqlState(insert(table, { ...row, [name]: null })), name).toBe('23502');
      }
    }
  });
}

const INVALID_DELIVERIES: [string, unknown][] = [
  ...['', 'c0', 'c01', 'C1', '1'].map((value): [string, unknown] => ['card_id', value]),
  ['position', 0],
  ['final_price_fen', -1n],
  ['product_key', ''],
  ...['', 'TAOBAO', 'tmall', '__unknown__'].map((value): [string, unknown] => ['platform', value]),
  ...['[]', '"synthetic"', '1', 'null'].map((value): [string, unknown] => ['card', value]),
];
for (const [name, value] of INVALID_DELIVERIES) {
  it(`[AC-B3-09d#3][BR-AI-05] deliveries rejects ${name}=${String(value)} with CHECK violation`, async () => {
    const row = await fixture('agent_result_deliveries');
    expect(await sqlState(insert('agent_result_deliveries', { ...row, [name]: value }))).toBe(
      CHECK,
    );
  });
}

it('[AC-B3-09d#3][BR-AI-05] deliveries accepts all nine platforms, position reuse, c1/c10 and exact bigint prices', async () => {
  const row = await fixture('agent_result_deliveries');
  for (const [index, platform] of PLATFORMS.entries()) {
    expect(
      await sqlState(
        insert('agent_result_deliveries', {
          ...row,
          platform,
          card_id: `c${String(index + 1)}`,
          final_price_fen: 0n,
        }),
      ),
      platform,
    ).toBe(OK);
  }
  expect(
    await sqlState(
      insert('agent_result_deliveries', {
        ...row,
        card_id: 'c10',
        final_price_fen: 9007199254740993n,
      }),
    ),
  ).toBe(OK);
  const stored = await sql<{ final_price_fen: bigint; card: unknown }>`
    SELECT final_price_fen, card FROM app.agent_result_deliveries
    WHERE app_id = ${row['app_id']} AND session_id = ${row['session_id']} AND card_id = 'c10'
  `.execute(app);
  expect(stored.rows).toEqual([
    {
      final_price_fen: 9007199254740993n,
      card: { title: 'synthetic product', url: 'https://example.invalid/product' },
    },
  ]);
});

for (const slot of ['', 'PRICE', 'REFERENCE', 'PLATFORM', '__unknown__']) {
  it(`[AC-B3-09d#3][BR-AI-08] clarify rejects slot=${slot}`, async () => {
    const row = await fixture('agent_clarify_asks');
    expect(await sqlState(insert('agent_clarify_asks', { ...row, slot }))).toBe(CHECK);
  });
}

for (const table of ['agent_clarify_asks', 'agent_result_chains'] as const) {
  it(`[AC-B3-09d#3][BR-AI-08] ${table} rejects an empty chain_id`, async () => {
    const row = await fixture(table);
    const conditions = table === 'agent_result_chains' ? { conditions: '{"chain_id":""}' } : {};
    expect(await sqlState(insert(table, { ...row, ...conditions, chain_id: '' }))).toBe(CHECK);
  });
}

const INVALID_CHAINS: [string, unknown][] = [
  ['seq', 0],
  ['status', '__unknown__'],
  ['status', ''],
  ['status', 'HAS_PRODUCTS'],
  ...['[]', '"synthetic"', '1', 'null', '{}', '{"chain_id":null}', '{"chain_id":"other"}'].map(
    (value): [string, unknown] => ['conditions', value],
  ),
  ['conditions', null],
];
for (const [name, value] of INVALID_CHAINS) {
  it(`[AC-B3-09d#3][BR-AI-08] chains rejects ${name}=${String(value)} (has_products requires matching conditions)`, async () => {
    const row = await fixture('agent_result_chains');
    expect(await sqlState(insert('agent_result_chains', { ...row, [name]: value }))).toBe(CHECK);
  });
}

for (const status of ['searching', 'awaiting_price', 'has_products']) {
  it(`[AC-B3-09d#3][BR-AI-08] chains accepts ${status} and only pending states allow SQL NULL conditions`, async () => {
    const row = await fixture('agent_result_chains');
    expect(await sqlState(insert('agent_result_chains', { ...row, status }))).toBe(OK);
    expect(
      await sqlState(
        insert('agent_result_chains', {
          ...row,
          status,
          seq: 2,
          conditions: null,
        }),
      ),
    ).toBe(status === 'has_products' ? CHECK : OK);
    // Shape and chain binding also apply while a chain is awaiting results.
    expect(
      await sqlState(
        insert('agent_result_chains', {
          ...row,
          status,
          seq: 3,
          conditions: '{"chain_id":"other"}',
        }),
      ),
    ).toBe(CHECK);
  });
}

it('[AC-B3-09d#4][BR-AI-05] delivery card IDs cannot be reused across runs/sets within a session, but another session or app may reuse them', async () => {
  await requireTable('agent_result_deliveries');
  const owner = await session();
  const row = await fixture('agent_result_deliveries', owner);
  expect(await sqlState(insert('agent_result_deliveries', row))).toBe(OK);
  expect(await sqlState(insert('agent_result_deliveries', row))).toBe(UNIQUE);
  const otherSet = await resultSet({ id: row['run_id'], app_id: row['app_id'] });
  expect(
    await sqlState(insert('agent_result_deliveries', { ...row, result_set_id: otherSet['id'] })),
  ).toBe(UNIQUE);
  const otherRun = await fixture('agent_result_deliveries', owner);
  expect(await sqlState(insert('agent_result_deliveries', otherRun))).toBe(UNIQUE);
  for (const appId of ['synthetic-agent-results', 'synthetic-other-app']) {
    const other = await fixture('agent_result_deliveries', await session(appId));
    expect(await sqlState(insert('agent_result_deliveries', other))).toBe(OK);
  }
});

it('[AC-B3-09d#4][BR-AI-08] clarify deduplicates one slot per chain and permits other slots, chains, sessions and apps', async () => {
  const row = await fixture('agent_clarify_asks');
  expect(await sqlState(insert('agent_clarify_asks', row))).toBe(OK);
  expect(await sqlState(insert('agent_clarify_asks', row))).toBe(UNIQUE);
  for (const slot of ['reference', 'platform']) {
    expect(await sqlState(insert('agent_clarify_asks', { ...row, slot }))).toBe(OK);
  }
  expect(
    await sqlState(insert('agent_clarify_asks', { ...row, chain_id: 'synthetic-other-chain' })),
  ).toBe(OK);
  for (const appId of ['synthetic-agent-results', 'synthetic-other-app']) {
    const other = await fixture('agent_clarify_asks', await session(appId));
    expect(await sqlState(insert('agent_clarify_asks', other))).toBe(OK);
  }
});

it('[AC-B3-09d#4][BR-AI-08] clarify ON CONFLICT DO NOTHING returns one row then zero rows', async () => {
  const row = await fixture('agent_clarify_asks');
  for (const count of [1, 0, 0]) {
    const result = await sql`${insertStatement('agent_clarify_asks', row)}
      ON CONFLICT (app_id, session_id, chain_id, slot) DO NOTHING RETURNING slot`.execute(app);
    expect(result.rows).toHaveLength(count);
  }
});

for (const onConflict of [false, true]) {
  it(`[AC-B3-09d#4][BR-AI-08] two independent connections racing one clarify key insert exactly one row (onConflict=${String(onConflict)})`, async () => {
    const row = await fixture('agent_clarify_asks');
    await app.connection().execute(async (left) => {
      await app.connection().execute(async (right) => {
        const pids = await Promise.all(
          [left, right].map((db) =>
            sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db),
          ),
        );
        expect(pids[0]!.rows[0]!.pid).not.toBe(pids[1]!.rows[0]!.pid);
        if (onConflict) {
          const outcomes = await Promise.all(
            [left, right].map((db) =>
              sql`${insertStatement('agent_clarify_asks', row)}
              ON CONFLICT (app_id, session_id, chain_id, slot) DO NOTHING RETURNING slot`.execute(
                db,
              ),
            ),
          );
          expect(outcomes.map((result) => result.rows.length).sort()).toEqual([0, 1]);
        } else {
          const outcomes = await Promise.all(
            [left, right].map((db) =>
              sqlState(insertStatement('agent_clarify_asks', row).execute(db)),
            ),
          );
          expect(outcomes.sort()).toEqual([UNIQUE, OK].sort());
        }
      });
    });
    const stored = await sql`SELECT slot FROM app.agent_clarify_asks
      WHERE app_id = ${row['app_id']} AND session_id = ${row['session_id']}
        AND chain_id = ${row['chain_id']} AND slot = ${row['slot']}`.execute(app);
    expect(stored.rows).toEqual([{ slot: 'price' }]);
  });
}

it('[AC-B3-09d#4][BR-AI-08] chains rejects repeated session seq even with another chain_id; another session/app starts at one', async () => {
  const row = await fixture('agent_result_chains');
  expect(await sqlState(insert('agent_result_chains', row))).toBe(OK);
  expect(await sqlState(insert('agent_result_chains', row))).toBe(UNIQUE);
  expect(
    await sqlState(
      insert('agent_result_chains', {
        ...row,
        chain_id: 'synthetic-other-chain',
        conditions: '{"chain_id":"synthetic-other-chain"}',
      }),
    ),
  ).toBe(UNIQUE);
  for (const appId of ['synthetic-agent-results', 'synthetic-other-app']) {
    const other = await fixture('agent_result_chains', await session(appId));
    expect(await sqlState(insert('agent_result_chains', other))).toBe(OK);
  }
});

const EXPECTED_FKS: [Table, string[], string, string[]][] = [
  [
    'agent_result_deliveries',
    ['app_id', 'session_id', 'run_id'],
    'agent_runs',
    ['app_id', 'session_id', 'id'],
  ],
  [
    'agent_result_deliveries',
    ['app_id', 'run_id', 'result_set_id'],
    'agent_result_sets',
    ['app_id', 'run_id', 'id'],
  ],
  ['agent_clarify_asks', ['app_id', 'session_id'], 'agent_sessions', ['app_id', 'id']],
  ['agent_result_chains', ['app_id', 'session_id'], 'agent_sessions', ['app_id', 'id']],
];
for (const [table, source, target, referenced] of EXPECTED_FKS) {
  it(`[AC-B3-09d#5][BR-AI-05][BR-AI-08] ${table}(${source.join(',')}) references ${target} with validated NO ACTION`, async () => {
    await requireTable(table);
    expect(await foreignKeys(table)).toContainEqual({
      source,
      target,
      referenced,
      on_delete: 'a',
      on_update: 'a',
      validated: true,
    });
  });
}

for (const table of TABLES) {
  it(`[AC-B3-09d#5][BR-AI-05][BR-AI-08] ${table} rejects a nonexistent session and cross-app session ownership`, async () => {
    const row = await fixture(table);
    expect(await sqlState(insert(table, { ...row, session_id: randomUUID() }))).toBe(FK);
    expect(await sqlState(insert(table, { ...row, app_id: 'synthetic-wrong-app' }))).toBe(FK);
  });
}

it('[AC-B3-09d#5][BR-AI-05] deliveries rejects nonexistent runs/sets, wrong-session runs, wrong-run sets and foreign-app sets', async () => {
  await requireTable('agent_result_deliveries');
  const owner = await session();
  const row = await fixture('agent_result_deliveries', owner);
  for (const name of ['run_id', 'result_set_id']) {
    expect(
      await sqlState(insert('agent_result_deliveries', { ...row, [name]: randomUUID() })),
      name,
    ).toBe(FK);
  }
  // Keep the run/set FK valid while violating only the run/session FK.
  const otherSession = await fixture('agent_result_deliveries');
  expect(
    await sqlState(
      insert('agent_result_deliveries', {
        ...row,
        run_id: otherSession['run_id'],
        result_set_id: otherSession['result_set_id'],
      }),
    ),
  ).toBe(FK);
  // Keep run/session valid while referencing a set owned by another run in this session.
  const otherRun = await fixture('agent_result_deliveries', owner);
  expect(
    await sqlState(
      insert('agent_result_deliveries', {
        ...row,
        result_set_id: otherRun['result_set_id'],
      }),
    ),
  ).toBe(FK);
  const foreignApp = await fixture('agent_result_deliveries', await session('synthetic-other-app'));
  expect(
    await sqlState(
      insert('agent_result_deliveries', {
        ...row,
        result_set_id: foreignApp['result_set_id'],
      }),
    ),
  ).toBe(FK);
  expect(await sqlState(insert('agent_result_deliveries', row))).toBe(OK);
});

for (const table of TABLES) {
  it(`[AC-B3-09d#6][BR-AI-05][BR-AI-08] ${table} is append-only for couli_app without user triggers`, async () => {
    const row = await fixture(table);
    expect(await sqlState(insert(table, row))).toBe(OK);
    const stored = await sql<Row>`SELECT * FROM ${sql.table(`app.${table}`)}
      WHERE app_id = ${row['app_id']} AND session_id = ${row['session_id']}`.execute(app);
    expect(stored.rows).toHaveLength(1);
    expect(
      await sqlState(
        sql`UPDATE ${sql.table(`app.${table}`)} SET created_at = ${AT}
      WHERE app_id = ${row['app_id']} AND session_id = ${row['session_id']}`.execute(app),
      ),
    ).toBe(DENIED);
    expect(
      await sqlState(
        sql`DELETE FROM ${sql.table(`app.${table}`)}
      WHERE app_id = ${row['app_id']} AND session_id = ${row['session_id']}`.execute(app),
      ),
    ).toBe(DENIED);
    expect(await sqlState(sql`TRUNCATE ${sql.table(`app.${table}`)}`.execute(app))).toBe(DENIED);
    const privileges = await sql<{ forbidden: boolean; column_update: boolean }>`SELECT
      has_table_privilege('couli_app', ${`app.${table}`}, 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS forbidden,
      has_any_column_privilege('couli_app', ${`app.${table}`}, 'UPDATE,REFERENCES') AS column_update`.execute(
      app,
    );
    expect(privileges.rows).toEqual([{ forbidden: false, column_update: false }]);
    const triggers = await sql`SELECT tgname FROM pg_trigger
      WHERE tgrelid = to_regclass(${`app.${table}`}) AND NOT tgisinternal`.execute(app);
    expect(triggers.rows).toEqual([]);
    const after = await sql<Row>`SELECT * FROM ${sql.table(`app.${table}`)}
      WHERE app_id = ${row['app_id']} AND session_id = ${row['session_id']}`.execute(app);
    expect(after.rows).toEqual(stored.rows);
  });

  it(`[AC-B3-09d#6][BR-AI-05][BR-AI-08] readonly can read ${table} except chains.conditions and cannot write`, async () => {
    const row = await fixture(table);
    await insert(table, row);
    const reader = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
    try {
      for (const column of Object.keys(SHAPES[table])) {
        const query = sql`SELECT ${sql.ref(column)} FROM ${sql.table(`app.${table}`)}
          WHERE session_id = ${row['session_id']}`;
        if (table === 'agent_result_chains' && column === 'conditions') {
          expect(await sqlState(query.execute(reader))).toBe(DENIED);
        } else {
          expect((await query.execute(reader)).rows, column).toHaveLength(1);
        }
      }
      if (table === 'agent_result_chains') {
        expect(await sqlState(sql`SELECT * FROM app.agent_result_chains`.execute(reader))).toBe(
          DENIED,
        );
      }
      const fresh = await fixture(table);
      expect(await sqlState(insertStatement(table, fresh).execute(reader))).toBe(DENIED);
      expect(
        await sqlState(
          sql`UPDATE ${sql.table(`app.${table}`)} SET created_at = ${AT}
        WHERE session_id = ${row['session_id']}`.execute(reader),
        ),
      ).toBe(DENIED);
      expect(
        await sqlState(
          sql`DELETE FROM ${sql.table(`app.${table}`)}
        WHERE session_id = ${row['session_id']}`.execute(reader),
        ),
      ).toBe(DENIED);
      const permissions = await sql<{ table_write: boolean; column_write: boolean }>`SELECT
        has_table_privilege('couli_readonly', ${`app.${table}`}, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS table_write,
        has_any_column_privilege('couli_readonly', ${`app.${table}`}, 'INSERT,UPDATE,REFERENCES') AS column_write`.execute(
        app,
      );
      expect(permissions.rows).toEqual([{ table_write: false, column_write: false }]);
    } finally {
      await destroyDb(reader);
    }
  });

  it(`[AC-B3-09d#6][BR-AI-05][BR-AI-08] payout and maint have no table or column privileges on ${table}`, async () => {
    await requireTable(table);
    for (const role of ['couli_payout', 'couli_maint']) {
      const privileges = await sql<{ table_access: boolean; column_access: boolean }>`SELECT
        has_table_privilege(${role}, ${`app.${table}`}, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS table_access,
        has_any_column_privilege(${role}, ${`app.${table}`}, 'SELECT,INSERT,UPDATE,REFERENCES') AS column_access`.execute(
        app,
      );
      expect(privileges.rows, role).toEqual([{ table_access: false, column_access: false }]);
    }
  });
}

it('[AC-B3-09d#7][BR-AI-05] result_sets/cards keep their columns; only result_sets gains the composite reference key', async () => {
  await requireTable('agent_result_deliveries');
  await requireTable('agent_result_sets');
  await requireTable('agent_cards');
  expect((await columns('agent_result_sets')).map((column) => column.name).sort()).toEqual(
    ['id', 'app_id', 'run_id', 'conditions', 'created_at'].sort(),
  );
  const cardColumns = (await columns('agent_cards')).map((column) => column.name);
  expect(cardColumns.sort()).toEqual(
    [
      'id',
      'app_id',
      'session_id',
      'run_id',
      'card_id',
      'type',
      'data',
      'link_id',
      'schema_version',
      'fallback_text',
      'created_at',
    ].sort(),
  );
  expect(
    cardColumns.filter(
      (name) => name.includes('_price') || name.endsWith('_fen') || name === 'card',
    ),
  ).toEqual([]);
  expect(await uniqueKeys('agent_result_sets')).toContainEqual(['app_id', 'id', 'run_id']);
});

it('[AC-B3-09d#8][BR-AI-08] chains appends seq 1/2/3, latest is max seq and prior rows remain unchanged', async () => {
  const row = await fixture('agent_result_chains');
  await insert('agent_result_chains', { ...row, status: 'searching', conditions: null });
  const first = await sql<Row>`SELECT * FROM app.agent_result_chains
    WHERE app_id = ${row['app_id']} AND session_id = ${row['session_id']} AND seq = 1`.execute(app);
  expect(first.rows).toHaveLength(1);
  await insert('agent_result_chains', {
    ...row,
    seq: 2,
    status: 'awaiting_price',
    conditions: null,
  });
  const before = await sql<Row>`SELECT * FROM app.agent_result_chains
    WHERE app_id = ${row['app_id']} AND session_id = ${row['session_id']} ORDER BY seq`.execute(
    app,
  );
  expect(before.rows).toHaveLength(2);
  await insert('agent_result_chains', { ...row, seq: 3 });
  const latest =
    await sql<Row>`SELECT seq, chain_id, status, conditions FROM app.agent_result_chains
    WHERE app_id = ${row['app_id']} AND session_id = ${row['session_id']} ORDER BY seq DESC LIMIT 1`.execute(
      app,
    );
  expect(latest.rows).toEqual([
    {
      seq: 3,
      chain_id: 'synthetic-chain',
      status: 'has_products',
      conditions: { chain_id: 'synthetic-chain', q: 'synthetic product' },
    },
  ]);
  const all = await sql<Row>`SELECT * FROM app.agent_result_chains
    WHERE app_id = ${row['app_id']} AND session_id = ${row['session_id']} ORDER BY seq`.execute(
    app,
  );
  expect(all.rows).toHaveLength(3);
  expect(all.rows.slice(0, 2)).toEqual(before.rows);
  expect(all.rows.slice(0, 1)).toEqual(first.rows);
});
