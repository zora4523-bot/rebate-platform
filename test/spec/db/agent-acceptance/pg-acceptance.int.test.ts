// B3-09b: BR-AI-23 / BR-AI-15, task §9 design §1.2–1.4.
// Catalog assertions precede DML so the absent additive migration is assertion-red.
// Only couli_app connections; no application admission/finalization implementation here.
// Existing B3-09a tests remain the regression oracle for the unchanged 0021 protections.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { columns, connect, insertRow, requireTable, sqlState } from '../linking-bindings/kit.ts';

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
type Table = 'agent_sessions' | 'agent_runs';
const AT = new Date('2026-10-08T15:59:50Z');
const DEADLINE = new Date('2026-10-08T16:00:10Z');
const LOCK_UNTIL = new Date('2026-10-08T16:00:40Z');
const BEFORE = new Date('2026-10-08T15:59:49.999Z');
const OK = 'no error';
const CHECK = '23514';
const REWRITE = '23001';
const DENIED = '42501';
const NEW_COLUMNS: Record<Table, Record<string, string>> = {
  agent_sessions: { run_lock_run_id: 'uuid', run_lock_expires_at: 'timestamptz' },
  agent_runs: {
    deadline_at: 'timestamptz',
    end_draft: 'jsonb',
    cancel_requested_at: 'timestamptz',
    finalize_hold: 'text',
    finalize_hold_at: 'timestamptz',
  },
};
const frame = (type = 'done') => ({ type, data: {} });
const finished = {
  end_reason: 'stop',
  settle_result: 'counted',
  settled_at: DEADLINE,
  final_event: JSON.stringify(frame()),
  ended_at: DEADLINE,
};

async function ready(table: Table): Promise<void> {
  await requireTable(table);
  const present = (await columns(table)).map((column) => column.name);
  for (const name of Object.keys(NEW_COLUMNS[table])) {
    expect(present, `app.${table}.${name} exists before DML`).toContain(name);
  }
}

async function insert(table: Table, row: Row): Promise<Row> {
  await ready(table);
  const names = Object.keys(row);
  const result = await sql<Row>`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))}) RETURNING *`.execute(app);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function session(values: Row = {}): Promise<Row> {
  await ready('agent_sessions');
  const deviceId = randomUUID();
  await insertRow('devices', {
    id: deviceId,
    app_id: 'couli',
    user_id: null,
    install_secret_cipher: Buffer.from('synthetic-install-secret'),
    last_seen_at: AT,
  });
  return insert('agent_sessions', {
    id: randomUUID(),
    app_id: 'couli',
    device_id: deviceId,
    started_at: AT,
    last_active_at: AT,
    ...values,
  });
}

async function run(values: Row = {}, parent?: Row): Promise<Row> {
  await ready('agent_runs');
  const owner = parent ?? (await session());
  return insert('agent_runs', {
    id: randomUUID(),
    app_id: 'couli',
    session_id: owner['id'],
    accepted_at: AT,
    quota_subjects: ['["device","synthetic-device"]', '["ip","synthetic-ip-key"]'],
    prompt_version: 'synthetic@1',
    ...values,
  });
}

async function update(table: Table, id: unknown, values: Row): Promise<void> {
  await ready(table);
  const result = await sql`UPDATE ${sql.table(`app.${table}`)} SET
    ${sql.join(Object.entries(values).map(([key, value]) => sql`${sql.ref(key)} = ${value}`))}
    WHERE app_id = 'couli' AND id = ${id} RETURNING id`.execute(app);
  expect(result.rows).toEqual([{ id }]);
}

async function read(table: Table, id: unknown): Promise<Row> {
  await ready(table);
  const result = await sql<Row>`SELECT * FROM ${sql.table(`app.${table}`)}
    WHERE app_id = 'couli' AND id = ${id}`.execute(app);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

for (const table of ['agent_sessions', 'agent_runs'] as const) {
  it(`[AC-B3-09b#1] ${table}: additive columns have exact types, nullable and no defaults`, async () => {
    await ready(table);
    const actual = await columns(table);
    for (const [name, type] of Object.entries(NEW_COLUMNS[table])) {
      expect(actual.find((column) => column.name === name)).toEqual({
        name,
        type,
        nullable: true,
        hasDefault: false,
      });
    }
    // Old writers omit every new column: INSERT must remain valid and store SQL NULL.
    const row = table === 'agent_sessions' ? await session() : await run();
    for (const name of Object.keys(NEW_COLUMNS[table])) expect(row[name], name).toBeNull();
  });
}

it('[AC-B3-09b#2] session lock accepts both NULL or both present; rejects either half alone', async () => {
  const owner = await session();
  const pending = await run({ deadline_at: DEADLINE }, owner);
  const lock = { run_lock_run_id: pending['id'], run_lock_expires_at: LOCK_UNTIL };
  expect(await sqlState(update('agent_sessions', owner['id'], lock))).toBe(OK);
  const locked = await read('agent_sessions', owner['id']);
  expect(locked).toMatchObject(lock);
  for (const values of [{ run_lock_run_id: null }, { run_lock_expires_at: null }]) {
    expect(await sqlState(update('agent_sessions', owner['id'], values))).toBe(CHECK);
    expect(await read('agent_sessions', owner['id'])).toEqual(locked);
  }
  expect(
    await sqlState(
      update('agent_sessions', owner['id'], {
        run_lock_run_id: null,
        run_lock_expires_at: null,
      }),
    ),
  ).toBe(OK);
  expect(await read('agent_sessions', owner['id'])).toMatchObject({
    run_lock_run_id: null,
    run_lock_expires_at: null,
  });
  // A later run can acquire the same session lock (these columns are not write-once).
  const next = await run({ deadline_at: DEADLINE }, owner);
  expect(
    await sqlState(
      update('agent_sessions', owner['id'], {
        ...lock,
        run_lock_run_id: next['id'],
      }),
    ),
  ).toBe(OK);
  expect(await read('agent_sessions', owner['id'])).toMatchObject({ run_lock_run_id: next['id'] });
});

for (const column of ['deadline_at', 'cancel_requested_at'] as const) {
  it(`[AC-B3-09b#3] ${column} allows NULL, equality and later times; rejects before accepted_at`, async () => {
    await ready('agent_runs');
    for (const value of [null, AT, DEADLINE]) {
      const stored = await run({ [column]: value });
      expect(stored[column]).toEqual(value);
    }
    expect(await sqlState(run({ [column]: BEFORE }))).toBe(CHECK);
  });
}

it('[AC-B3-09b#4] end_draft accepts SQL NULL or an exact done/error envelope with a reason', async () => {
  expect((await run({ end_draft: null }))['end_draft']).toBeNull();
  for (const type of ['done', 'error']) {
    const draft = { type, data: { synthetic: { nested: true } } };
    expect(
      (await run({ end_reason: 'stop', end_draft: JSON.stringify(draft) }))['end_draft'],
    ).toEqual(draft);
  }
});

const BAD_DRAFTS: [string, unknown][] = [
  ['JSON null', null],
  ['boolean', false],
  ['number', 1],
  ['string', 'done'],
  ['array', []],
  ['empty object', {}],
  ['missing type', { data: {} }],
  ['missing data', { type: 'done' }],
  ['null type', { type: null, data: {} }],
  ['numeric type', { type: 1, data: {} }],
  ['non-terminal type', { type: 'card', data: {} }],
  ['null data', { type: 'done', data: null }],
  ['array data', { type: 'done', data: [] }],
  ['string data', { type: 'error', data: 'invalid' }],
  ['boolean data', { type: 'error', data: true }],
  ['number data', { type: 'done', data: 1 }],
  ['extra key', { ...frame(), extra: null }],
];
for (const [label, draft] of BAD_DRAFTS) {
  it(`[AC-B3-09b#5] end_draft rejects ${label} with CHECK violation`, async () => {
    await ready('agent_runs');
    expect(await sqlState(run({ end_reason: 'stop', end_draft: JSON.stringify(draft) }))).toBe(
      CHECK,
    );
  });
}

it('[AC-B3-09b#6] draft requires a persisted reason; reason alone remains compatible', async () => {
  const pending = await run();
  const draft = JSON.stringify(frame());
  expect(await sqlState(update('agent_runs', pending['id'], { end_draft: draft }))).toBe(CHECK);
  expect((await read('agent_runs', pending['id']))['end_draft']).toBeNull();
  expect(await sqlState(update('agent_runs', pending['id'], { end_reason: 'stop' }))).toBe(OK);
  expect((await read('agent_runs', pending['id']))['end_draft']).toBeNull();
  expect(await sqlState(update('agent_runs', pending['id'], { end_draft: draft }))).toBe(OK);
  expect((await read('agent_runs', pending['id']))['end_draft']).toEqual(frame());
});

for (const hold of ['stored_frame_invalid', 'facts_inconsistent']) {
  it(`[AC-B3-09b#7] finalize_hold accepts ${hold} on an open run with its timestamp`, async () => {
    const pending = await run();
    const values = { finalize_hold: hold, finalize_hold_at: DEADLINE };
    expect(await sqlState(update('agent_runs', pending['id'], values))).toBe(OK);
    expect(await read('agent_runs', pending['id'])).toMatchObject(values);
    expect(
      await sqlState(
        update('agent_runs', pending['id'], {
          finalize_hold: null,
          finalize_hold_at: null,
        }),
      ),
    ).toBe(OK);
    expect(await read('agent_runs', pending['id'])).toMatchObject({
      finalize_hold: null,
      finalize_hold_at: null,
    });
  });
}

for (const hold of ['', 'unknown', 'STORED_FRAME_INVALID']) {
  it(`[AC-B3-09b#8] finalize_hold rejects unknown value ${JSON.stringify(hold)}`, async () => {
    const pending = await run();
    expect(
      await sqlState(
        update('agent_runs', pending['id'], {
          finalize_hold: hold,
          finalize_hold_at: DEADLINE,
        }),
      ),
    ).toBe(CHECK);
    expect(await read('agent_runs', pending['id'])).toEqual(pending);
  });
}

it('[AC-B3-09b#9] finalize_hold and finalize_hold_at reject both kinds of unpaired value', async () => {
  const pending = await run();
  for (const values of [{ finalize_hold: 'facts_inconsistent' }, { finalize_hold_at: DEADLINE }]) {
    expect(await sqlState(update('agent_runs', pending['id'], values))).toBe(CHECK);
    expect(await read('agent_runs', pending['id'])).toEqual(pending);
  }
});

it('[AC-B3-09b#10] held runs cannot become terminal; terminal runs cannot be held', async () => {
  const hold = { finalize_hold: 'facts_inconsistent', finalize_hold_at: DEADLINE };
  const pending = await run(hold);
  expect(pending).toMatchObject({ ...hold, final_event: null });
  expect(await sqlState(update('agent_runs', pending['id'], finished))).toBe(CHECK);
  expect(await read('agent_runs', pending['id'])).toEqual(pending);
  const terminal = await run(finished);
  expect(terminal).toMatchObject({ final_event: frame(), finalize_hold: null });
  expect(await sqlState(update('agent_runs', terminal['id'], hold))).toBe(CHECK);
  expect(await read('agent_runs', terminal['id'])).toEqual(terminal);
});

for (const ended of [false, true]) {
  it(`[AC-B3-09b#11] end_draft writes once, permits identical retry, rejects replacement/clear (ended=${String(ended)})`, async () => {
    const pending = await run();
    const values = { end_reason: 'stop', end_draft: JSON.stringify(frame()) };
    expect(await sqlState(update('agent_runs', pending['id'], values))).toBe(OK);
    if (ended) expect(await sqlState(update('agent_runs', pending['id'], finished))).toBe(OK);
    const before = await read('agent_runs', pending['id']);
    expect(before['end_draft']).toEqual(frame());
    expect(await sqlState(update('agent_runs', pending['id'], values))).toBe(OK);
    for (const replacement of [
      JSON.stringify(frame('error')),
      JSON.stringify({ type: 'done', data: { changed: true } }),
      null,
    ]) {
      expect(await sqlState(update('agent_runs', pending['id'], { end_draft: replacement }))).toBe(
        REWRITE,
      );
      expect(await read('agent_runs', pending['id'])).toEqual(before);
    }
  });

  it(`[AC-B3-09b#12] cancellation writes once, permits identical retry, rejects replacement/clear (ended=${String(ended)})`, async () => {
    const pending = await run({ deadline_at: DEADLINE });
    expect(await sqlState(update('agent_runs', pending['id'], { cancel_requested_at: AT }))).toBe(
      OK,
    );
    if (ended)
      expect(
        await sqlState(
          update('agent_runs', pending['id'], {
            ...finished,
            end_reason: 'cancelled',
          }),
        ),
      ).toBe(OK);
    const before = await read('agent_runs', pending['id']);
    expect(before['cancel_requested_at']).toEqual(AT);
    expect(await sqlState(update('agent_runs', pending['id'], { cancel_requested_at: AT }))).toBe(
      OK,
    );
    for (const replacement of [DEADLINE, null]) {
      expect(
        await sqlState(
          update('agent_runs', pending['id'], {
            cancel_requested_at: replacement,
          }),
        ),
      ).toBe(REWRITE);
      expect(await read('agent_runs', pending['id'])).toEqual(before);
    }
  });
}

it('[AC-B3-09b#13] deadline is insert-only; application UPDATE is denied even for NULL or no-op', async () => {
  for (const original of [null, DEADLINE]) {
    const pending = await run({ deadline_at: original });
    expect(pending['deadline_at']).toEqual(original);
    for (const replacement of [original, null, LOCK_UNTIL]) {
      expect(
        await sqlState(update('agent_runs', pending['id'], { deadline_at: replacement })),
      ).toBe(DENIED);
      expect(await read('agent_runs', pending['id'])).toEqual(pending);
    }
  }
  // The application cannot exercise the deadline trigger past the ACL. Inspect the attached
  // prohibitive trigger's immutable ROW comparison without escalating to an owner connection.
  const result = await sql<{ source: string; config: string[]; enabled: string }>`
    SELECT p.prosrc AS source, p.proconfig AS config, t.tgenabled::text AS enabled
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = to_regclass('app.agent_runs') AND NOT t.tgisinternal
      AND t.tgname = 'agent_runs_no_rewrite' AND (t.tgtype & 19) = 19`.execute(app);
  expect(result.rows).toHaveLength(1);
  const trigger = result.rows[0]!;
  expect(trigger.enabled).toBe('O');
  expect(trigger.config).toContain('search_path=pg_catalog, pg_temp');
  expect(trigger.source).toMatch(
    /ROW\([^)]*NEW\.deadline_at[^)]*\)\s+IS\s+DISTINCT\s+FROM\s+ROW\([^)]*OLD\.deadline_at[^)]*\)/i,
  );
  expect(trigger.source).toMatch(/ERRCODE\s*=\s*'(restrict_violation|23001)'/i);
});

const INDEXES = [
  {
    name: 'agent_runs_quota_first_idx',
    table: 'agent_runs',
    keys: ['app_id', 'quota_subjects[1]', 'accepted_at'],
    predicate: null,
  },
  {
    name: 'agent_runs_quota_second_idx',
    table: 'agent_runs',
    keys: ['app_id', 'quota_subjects[2]', 'accepted_at'],
    predicate: 'cardinality(quota_subjects)=2',
  },
  {
    name: 'agent_sessions_run_lock_idx',
    table: 'agent_sessions',
    keys: ['run_lock_expires_at', 'id'],
    predicate: 'run_lock_run_idisnotnull',
  },
] as const;

for (const index of INDEXES) {
  it(`[AC-B3-09b#14] ${index.name} supports subject/time counting or expired-lock scans`, async () => {
    await ready(index.table);
    const result = await sql<{
      method: string;
      valid: boolean;
      ready: boolean;
      unique: boolean;
      keys: string[];
      predicate: string | null;
    }>`SELECT am.amname AS method, i.indisvalid AS valid, i.indisready AS ready,
        i.indisunique AS unique,
        ARRAY(SELECT pg_get_indexdef(i.indexrelid, pos, true)
          FROM generate_series(1, i.indnkeyatts) pos ORDER BY pos) AS keys,
        pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_am am ON am.oid = c.relam
      WHERE i.indrelid = to_regclass(${`app.${index.table}`}) AND c.relname = ${index.name}`.execute(
      app,
    );
    expect(result.rows).toHaveLength(1);
    const actual = result.rows[0]!;
    expect(actual).toMatchObject({ method: 'btree', valid: true, ready: true, unique: false });
    expect(actual.keys.map((key) => key.replace(/[()\s]/g, ''))).toEqual(index.keys);
    // Remove only the optional outer parentheses, preserving the cardinality() expression.
    expect(
      actual.predicate
        ?.toLowerCase()
        .replace(/\s/g, '')
        .replace(/^\((.*)\)$/, '$1') ?? null,
    ).toBe(index.predicate);
  });
}

for (const table of ['agent_sessions', 'agent_runs'] as const) {
  it(`[AC-B3-09b#15] ${table}: exact application and readonly privileges for new columns`, async () => {
    await ready(table);
    for (const column of Object.keys(NEW_COLUMNS[table])) {
      for (const role of ['couli_app', 'couli_readonly']) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
          const result = await sql<{ allowed: boolean }>`SELECT has_column_privilege(
            ${role}, ${`app.${table}`}, ${column}, ${privilege}) AS allowed`.execute(app);
          const allowed =
            privilege === 'SELECT' ||
            (role === 'couli_app' &&
              (privilege === 'INSERT' || (privilege === 'UPDATE' && column !== 'deadline_at')));
          expect(result.rows, `${role} ${table}.${column} ${privilege}`).toEqual([{ allowed }]);
        }
      }
    }
  });

  it(`[AC-B3-09b#16] ${table}: payout/maint acquire no rights to the new columns`, async () => {
    await ready(table);
    for (const role of ['couli_payout', 'couli_maint']) {
      for (const column of Object.keys(NEW_COLUMNS[table])) {
        const result = await sql<{ allowed: boolean }>`SELECT has_column_privilege(
          ${role}, ${`app.${table}`}, ${column}, 'SELECT,INSERT,UPDATE,REFERENCES') AS allowed`.execute(
          app,
        );
        expect(result.rows, `${role} ${table}.${column}`).toEqual([{ allowed: false }]);
      }
    }
  });
}
