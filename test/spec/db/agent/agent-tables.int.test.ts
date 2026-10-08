// B3-09a: BR-AI-19 / BR-AI-23, task §9 and plan.md §1.4 (including CT-08e columns).
// Catalog assertions precede DML: an absent migration fails assertions, not SQL name resolution.
// Only synthetic data and couli_app connections. No application/Redis/retention behavior here.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  columns,
  connect,
  foreignKeys,
  insertRow,
  newLink,
  newUser,
  requireTable,
  shape,
  sqlState,
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
const AT = new Date('2026-10-06T08:00:00Z');
const LATER = new Date('2026-10-06T08:01:00Z');
const BEFORE = new Date('2026-10-06T07:59:59Z');
const TABLES = [
  'agent_sessions',
  'agent_runs',
  'agent_messages',
  'agent_tool_calls',
  'agent_result_sets',
  'agent_cards',
] as const;
type Table = (typeof TABLES)[number];
const CHECK = '23514';
const FK = '23503';
const UNIQUE = '23505';
const REWRITE = '23001';
const DENIED = '42501';
const OK = 'no error';

// JSON is encoded explicitly; JS arrays are reserved for PostgreSQL text[] values.
const terminal = (type = 'done') => JSON.stringify({ type, data: {} });
const settled = { end_reason: 'stop', settle_result: 'counted', settled_at: AT };
const finished = { ...settled, final_event: terminal(), ended_at: LATER };

async function insert(table: Table, row: Row, db = app): Promise<Row> {
  await requireTable(table);
  const names = Object.keys(row);
  await sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))})`.execute(db);
  return row;
}

async function update(table: Table, id: unknown, values: Row, db = app): Promise<void> {
  await requireTable(table);
  const result = await sql`UPDATE ${sql.table(`app.${table}`)} SET
    ${sql.join(Object.entries(values).map(([key, value]) => sql`${sql.ref(key)} = ${value}`))}
    WHERE id = ${id} RETURNING id`.execute(db);
  expect(result.rows, `${table}: update addresses exactly one fixture`).toHaveLength(1);
}

async function read(table: Table, id: unknown): Promise<Row> {
  await requireTable(table);
  const result =
    await sql<Row>`SELECT * FROM ${sql.table(`app.${table}`)} WHERE id = ${id}`.execute(app);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function session(values: Row = {}): Promise<Row> {
  await requireTable('agent_sessions');
  const appId = String(values['app_id'] ?? 'couli');
  const deviceId = randomUUID();
  await insertRow('devices', {
    id: deviceId,
    app_id: appId,
    user_id: null,
    install_secret_cipher: Buffer.from('synthetic-install-secret'),
    last_seen_at: AT,
  });
  return insert('agent_sessions', {
    id: randomUUID(),
    app_id: appId,
    user_id: null,
    device_id: deviceId,
    started_at: AT,
    last_active_at: AT,
    ...values,
  });
}

async function run(values: Row = {}, owner?: Row): Promise<Row> {
  await requireTable('agent_runs');
  const parent = owner ?? (await session());
  return insert('agent_runs', {
    id: randomUUID(),
    app_id: parent['app_id'],
    session_id: parent['id'],
    accepted_at: AT,
    quota_subjects: ['synthetic-device-key', 'synthetic-ip-key'],
    prompt_version: 'synthetic@1',
    user_text: 'synthetic redacted request',
    ...values,
  });
}

async function message(values: Row = {}, parent?: Row): Promise<Row> {
  await requireTable('agent_messages');
  const source = parent ?? (await run());
  return insert('agent_messages', {
    id: randomUUID(),
    app_id: source['app_id'],
    session_id: source['session_id'],
    run_id: source['id'],
    role: 'assistant',
    client_msg_id: null,
    ...values,
  });
}

async function card(values: Row = {}, parent?: Row): Promise<Row> {
  await requireTable('agent_cards');
  const source = parent ?? (await run());
  return insert('agent_cards', {
    id: randomUUID(),
    app_id: source['app_id'],
    session_id: source['session_id'],
    run_id: source['id'],
    card_id: 'c1',
    type: 'notice',
    data: '{}',
    schema_version: 1,
    fallback_text: 'synthetic card summary',
    ...values,
  });
}

async function tool(values: Row = {}, parent?: Row): Promise<Row> {
  await requireTable('agent_tool_calls');
  const source = parent ?? (await run());
  return insert('agent_tool_calls', {
    id: randomUUID(),
    app_id: source['app_id'],
    run_id: source['id'],
    seq: 1,
    name: 'synthetic_tool',
    status: 'rejected',
    ...values,
  });
}

async function resultSet(values: Row = {}, parent?: Row): Promise<Row> {
  await requireTable('agent_result_sets');
  const source = parent ?? (await run());
  return insert('agent_result_sets', {
    id: randomUUID(),
    app_id: source['app_id'],
    run_id: source['id'],
    conditions: '{}',
    ...values,
  });
}

async function handler(): Promise<unknown> {
  const row = await insertRow('admin_users', { app_id: 'couli' });
  return row['id'];
}

// Read the small YAML values mapping directly, without introducing a YAML dependency.
function contractValues(name: string): string[] {
  const source = readFileSync(
    new URL('../../../../contracts/enums/ops.yaml', import.meta.url),
    'utf8',
  );
  const block = source.split(`\n  ${name}:\n`)[1]?.split(/\n  \S/)[0];
  expect(block, `contracts/enums/ops.yaml: ${name}`).toBeDefined();
  const values = [...(block ?? '').matchAll(/^      ([a-z_]+):/gm)].map((match) => match[1]!);
  expect(values.length, `${name} has values`).toBeGreaterThan(0);
  return values;
}

// Expected names/types/nullability come from the task, never from the migration under test.
const COMMON = { id: 'uuid', app_id: 'text', created_at: 'timestamptz' };
const MUTABLE = { row_version: 'int4', updated_at: 'timestamptz' };
const SHAPES: Record<Table, Record<string, string>> = {
  agent_sessions: {
    ...COMMON,
    ...MUTABLE,
    user_id: 'uuid?',
    device_id: 'uuid',
    started_at: 'timestamptz',
    last_active_at: 'timestamptz',
    expired_at: 'timestamptz?',
    card_seq: 'int4',
  },
  agent_runs: {
    ...COMMON,
    ...MUTABLE,
    session_id: 'uuid',
    user_text: 'text?',
    intent: 'text?',
    model: 'text?',
    model_snapshot: 'text?',
    prompt_version: 'text',
    input_tokens: 'int4?',
    output_tokens: 'int4?',
    cost_mfen: 'int8?',
    ttft_ms: 'int4?',
    latency_ms: 'int4?',
    finish_reason: 'text?',
    final_event: 'jsonb?',
    ended_at: 'timestamptz?',
    output_filtered: 'bool',
    filter_hits: '_text',
    output_truncated: 'bool',
    price_version: 'text?',
    result_check_provider: 'text?',
    judge_model: 'text?',
    page_guide_reject_reason: 'text?',
    accepted_at: 'timestamptz',
    quota_subjects: '_text',
    end_reason: 'text?',
    card_delivered: 'bool',
    settle_result: 'text?',
    settled_at: 'timestamptz?',
  },
  agent_messages: {
    ...COMMON,
    ...MUTABLE,
    session_id: 'uuid',
    run_id: 'uuid?',
    client_msg_id: 'text?',
    role: 'text',
    text: 'text?',
    card_ids: '_text',
    feedback: 'text?',
    feedback_at: 'timestamptz?',
    reported: 'bool',
    report_reason: 'text?',
    reported_at: 'timestamptz?',
    report_status: 'text?',
    report_handler_id: 'uuid?',
    report_handled_at: 'timestamptz?',
    report_note: 'text?',
    badcase: 'bool',
  },
  agent_tool_calls: {
    ...COMMON,
    run_id: 'uuid',
    seq: 'int4',
    name: 'text',
    args: 'jsonb?',
    result_digest: 'text?',
    status: 'text',
    latency_ms: 'int4?',
  },
  agent_result_sets: { ...COMMON, run_id: 'uuid', conditions: 'jsonb' },
  agent_cards: {
    ...COMMON,
    session_id: 'uuid',
    run_id: 'uuid',
    card_id: 'text',
    type: 'text',
    data: 'jsonb',
    link_id: 'uuid?',
    schema_version: 'int4',
    fallback_text: 'text',
  },
};

for (const table of TABLES) {
  it(`[AC-B3-09a#1] ${table} is an ordinary app table with the prescribed column shapes`, async () => {
    await requireTable(table);
    for (const [name, spec] of Object.entries(SHAPES[table])) {
      await shape(table, name, spec.replace(/\?$/, ''), spec.endsWith('?'));
    }
    expect((await columns(table)).find((column) => column.name === 'id')?.hasDefault).toBe(false);
    const primary = await sql<{ names: string[] }>`SELECT ARRAY(
      SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord
    ) AS names FROM pg_constraint c
    WHERE c.conrelid = to_regclass(${`app.${table}`}) AND c.contype = 'p'`.execute(app);
    expect(primary.rows).toEqual([{ names: ['id'] }]);
    if (table === 'agent_runs')
      expect((await columns(table)).map((c) => c.name)).not.toContain('cost_fen');
  });

  it(`[AC-B3-09a#2] ${table} leaves business timestamps and IDs to the caller`, async () => {
    await requireTable(table);
    const defaults = await sql<{ name: string; expression: string | null }>`
      SELECT a.attname AS name, pg_get_expr(d.adbin, d.adrelid) AS expression
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = to_regclass(${`app.${table}`}) AND a.attnum > 0 AND NOT a.attisdropped
    `.execute(app);
    expect(defaults.rows.length).toBeGreaterThan(0);
    for (const { name, expression } of defaults.rows) {
      expect(expression ?? '', `${table}.${name}`).not.toMatch(/uuidv7\s*\(/i);
      if (!['created_at', 'updated_at'].includes(name)) {
        expect(expression ?? '', `${table}.${name}`).not.toMatch(/\bnow\s*\(/i);
        if (name.endsWith('_at')) expect(expression, `${table}.${name}`).toBeNull();
      }
    }
  });
}

it('[AC-B3-09a#3] initial defaults preserve an unfinished run, blank reply and zero card sequence', async () => {
  const owner = await session();
  expect(await read('agent_sessions', owner['id'])).toMatchObject({ card_seq: 0, row_version: 0 });
  const pending = await run({}, owner);
  expect(await read('agent_runs', pending['id'])).toMatchObject({
    final_event: null,
    ended_at: null,
    end_reason: null,
    settle_result: null,
    settled_at: null,
    output_filtered: false,
    filter_hits: [],
    output_truncated: false,
    card_delivered: false,
    row_version: 0,
  });
  const reply = await message({}, pending);
  expect(await read('agent_messages', reply['id'])).toMatchObject({
    text: null,
    card_ids: [],
    reported: false,
    badcase: false,
    row_version: 0,
  });
});

for (const [column, contract] of [
  ['intent', 'agent_intent'],
  ['finish_reason', 'agent_finish_reason'],
  ['page_guide_reject_reason', 'page_guide_reject_reason'],
] as const) {
  it(`[AC-B3-09a#4] runs.${column} accepts exactly the contract vocabulary`, async () => {
    await requireTable('agent_runs');
    const allowed = contractValues(contract);
    for (const value of allowed) expect(await sqlState(run({ [column]: value })), value).toBe(OK);
    for (const value of ['', '__unknown__', ...allowed.map((v) => v.toUpperCase())]) {
      expect(await sqlState(run({ [column]: value })), value).toBe(CHECK);
    }
    expect(await sqlState(run({ [column]: null }))).toBe(OK);
  });
}

it('[AC-B3-09a#5] cards.type accepts all contract card types and rejects unknown/case/empty values', async () => {
  await requireTable('agent_cards');
  const allowed = contractValues('agent_card_type');
  for (const value of allowed) expect(await sqlState(card({ type: value })), value).toBe(OK);
  for (const value of ['', '__unknown__', ...allowed.map((v) => v.toUpperCase())]) {
    expect(await sqlState(card({ type: value })), value).toBe(CHECK);
  }
});

it('[AC-B3-09a#6] role is user/assistant and permits the two messages of one accepted run', async () => {
  const parent = await run();
  expect(
    await sqlState(message({ role: 'user', client_msg_id: 'synthetic-client-message' }, parent)),
  ).toBe(OK);
  expect(await sqlState(message({ role: 'assistant' }, parent))).toBe(OK);
  for (const role of ['', 'system', 'USER', 'ASSISTANT']) {
    expect(await sqlState(message({ role })), role).toBe(CHECK);
  }
});

it('[AC-B3-09a#7] feedback accepts up/down only', async () => {
  for (const feedback of ['up', 'down']) {
    expect(await sqlState(message({ feedback, feedback_at: AT, badcase: true }))).toBe(OK);
  }
  for (const feedback of ['', 'unknown', 'UP', 'DOWN']) {
    expect(await sqlState(message({ feedback, feedback_at: AT, badcase: true }))).toBe(CHECK);
  }
});

it('[AC-B3-09a#8] report_status accepts pending/handled only', async () => {
  await requireTable('agent_messages');
  const adminId = await handler();
  for (const report_status of ['pending', 'handled', '', 'unknown', 'PENDING', 'HANDLED']) {
    const handled = report_status === 'handled';
    const values = {
      reported: true,
      reported_at: AT,
      report_status,
      report_handled_at: handled ? LATER : null,
      report_handler_id: handled ? adminId : null,
    };
    expect(await sqlState(message(values)), report_status).toBe(
      ['pending', 'handled'].includes(report_status) ? OK : CHECK,
    );
  }
});

it('[AC-B3-09a#9] settle_result accepts counted/refunded only; end_reason stays open text', async () => {
  for (const settle_result of ['counted', 'refunded', '', 'unknown', 'COUNTED', 'REFUNDED']) {
    expect(
      await sqlState(run({ ...settled, settle_result, end_reason: 'future_run_ending' })),
      settle_result,
    ).toBe(['counted', 'refunded'].includes(settle_result) ? OK : CHECK);
  }
});

it('[AC-B3-09a#10] result_check_provider accepts rules/jev only', async () => {
  for (const provider of ['rules', 'jev', '', 'unknown', 'RULES', 'JEV']) {
    expect(await sqlState(run({ result_check_provider: provider })), provider).toBe(
      ['rules', 'jev'].includes(provider) ? OK : CHECK,
    );
  }
});

it('[AC-B3-09a#11] filter_hits accepts only amount/url/tpwd elements', async () => {
  for (const hits of [[], ['amount'], ['url'], ['tpwd'], ['amount', 'url', 'tpwd']]) {
    expect(await sqlState(run({ filter_hits: hits, output_filtered: hits.length > 0 }))).toBe(OK);
  }
  for (const hit of ['', 'unknown', 'AMOUNT', 'URL', 'TPWD', null]) {
    expect(
      await sqlState(run({ filter_hits: ['amount', hit], output_filtered: true })),
      String(hit),
    ).toBe(CHECK);
  }
});

it('[AC-B3-09a#12] client_msg_id deduplicates within one session, not across sessions', async () => {
  const owner = await session();
  const first = await run({}, owner);
  const second = await run({}, owner);
  const values = { role: 'user', client_msg_id: 'repeated-client-id' };
  expect(await sqlState(message(values, first))).toBe(OK);
  expect(await sqlState(message(values, second))).toBe(UNIQUE);
  expect(await sqlState(message(values))).toBe(OK);
});

it('[AC-B3-09a#13] multiple assistant NULL client IDs coexist, but each run has at most one of each role', async () => {
  const owner = await session();
  const first = await run({}, owner);
  const second = await run({}, owner);
  expect(await sqlState(message({}, first))).toBe(OK);
  expect(await sqlState(message({}, second))).toBe(OK);
  expect(await sqlState(message({}, first))).toBe(UNIQUE);
  expect(await sqlState(message({ role: 'user', client_msg_id: 'one' }, first))).toBe(OK);
  expect(await sqlState(message({ role: 'user', client_msg_id: 'two' }, first))).toBe(UNIQUE);
  // Legacy/context replies without a run are allowed by the nullable run_id design.
  expect(await sqlState(message({ run_id: null }, first))).toBe(OK);
  expect(await sqlState(message({ run_id: null }, first))).toBe(OK);
});

it('[AC-B3-09a#14] card IDs are unique across runs of the same session, reusable in another session', async () => {
  const owner = await session();
  const first = await run({}, owner);
  const second = await run({}, owner);
  expect(await sqlState(card({ card_id: 'c8' }, first))).toBe(OK);
  expect(await sqlState(card({ card_id: 'c8' }, second))).toBe(UNIQUE);
  expect(await sqlState(card({ card_id: 'c9' }, second))).toBe(OK);
  expect(await sqlState(card({ card_id: 'c8' }))).toBe(OK);
});

it('[AC-B3-09a#15] tool sequence deduplicates within a run only', async () => {
  const parent = await run();
  expect(await sqlState(tool({ seq: 1 }, parent))).toBe(OK);
  expect(await sqlState(tool({ seq: 1 }, parent))).toBe(UNIQUE);
  expect(await sqlState(tool({ seq: 2 }, parent))).toBe(OK);
  expect(await sqlState(tool({ seq: 1 }))).toBe(OK);
});

it('[AC-B3-09a#16] two distinct connections racing one client_msg_id yield exactly one inserted row', async () => {
  await requireTable('agent_messages');
  const owner = await session();
  const parents = [await run({}, owner), await run({}, owner)];
  const clientId = randomUUID();
  await app.connection().execute(async (left) => {
    await app.connection().execute(async (right) => {
      const pids = await Promise.all(
        [left, right].map((db) => sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db)),
      );
      expect(pids[0]!.rows[0]!.pid).not.toBe(pids[1]!.rows[0]!.pid);
      const outcomes = await Promise.all(
        [left, right].map((db, index) =>
          sqlState(
            insert(
              'agent_messages',
              {
                id: randomUUID(),
                app_id: 'couli',
                session_id: owner['id'],
                run_id: parents[index]!['id'],
                role: 'user',
                client_msg_id: clientId,
              },
              db,
            ),
          ),
        ),
      );
      expect(outcomes.sort()).toEqual([UNIQUE, OK].sort());
    });
  });
  const rows = await sql`SELECT id FROM app.agent_messages
    WHERE app_id = 'couli' AND session_id = ${owner['id']} AND client_msg_id = ${clientId}`.execute(
    app,
  );
  expect(rows.rows).toHaveLength(1);
});

const EXPECTED_FKS: [Table, string[], string, string[]][] = [
  ['agent_sessions', ['app_id', 'user_id'], 'users', ['app_id', 'id']],
  ['agent_sessions', ['app_id', 'device_id'], 'devices', ['app_id', 'id']],
  ['agent_runs', ['app_id', 'session_id'], 'agent_sessions', ['app_id', 'id']],
  ['agent_messages', ['app_id', 'session_id'], 'agent_sessions', ['app_id', 'id']],
  [
    'agent_messages',
    ['app_id', 'session_id', 'run_id'],
    'agent_runs',
    ['app_id', 'session_id', 'id'],
  ],
  ['agent_messages', ['app_id', 'report_handler_id'], 'admin_users', ['app_id', 'id']],
  ['agent_tool_calls', ['app_id', 'run_id'], 'agent_runs', ['app_id', 'id']],
  ['agent_result_sets', ['app_id', 'run_id'], 'agent_runs', ['app_id', 'id']],
  ['agent_cards', ['app_id', 'session_id', 'run_id'], 'agent_runs', ['app_id', 'session_id', 'id']],
  ['agent_cards', ['app_id', 'link_id'], 'links', ['app_id', 'link_id']],
];

for (const [table, source, target, referenced] of EXPECTED_FKS) {
  it(`[AC-B3-09a#17] ${table}(${source.join(',')}) has a validated NO ACTION FK to ${target}`, async () => {
    await requireTable(table);
    expect(await foreignKeys(table)).toContainEqual({
      source,
      target,
      referenced,
      on_delete: 'a',
      on_update: 'a',
      validated: true,
    });
    for (const key of await foreignKeys(table)) {
      expect(key).toMatchObject({ on_delete: 'a', on_update: 'a', validated: true });
    }
  });
}

it('[AC-B3-09a#18] a run cannot reference another app session', async () => {
  const owner = await session();
  expect(await sqlState(run({}, owner))).toBe(OK);
  expect(await sqlState(run({ app_id: 'other-app' }, owner))).toBe(FK);
});

for (const [name, make] of [
  ['agent_messages', message],
  ['agent_cards', card],
] as const) {
  it(`[AC-B3-09a#19] ${name} cannot attach a run from a different session`, async () => {
    await requireTable(name);
    const parent = await run();
    const other = await session();
    expect(await sqlState(make({}))).toBe(OK);
    expect(await sqlState(make({ session_id: other['id'] }, parent))).toBe(FK);
  });
}

it('[AC-B3-09a#20] cards accept a real link and reject nonexistent or cross-app links', async () => {
  await requireTable('agent_cards');
  expect(await sqlState(card({ link_id: await newLink() }))).toBe(OK);
  expect(await sqlState(card({ link_id: randomUUID() }))).toBe(FK);
  expect(await sqlState(card({ link_id: await newLink({ app_id: 'other-app' }) }))).toBe(FK);
});

it('[AC-B3-09a#21] durable links/orders/link_logs have no FK into expiring Agent tables', async () => {
  for (const table of TABLES) await requireTable(table);
  for (const table of ['links', 'orders', 'link_logs']) {
    const keys = await foreignKeys(table);
    expect(
      keys.filter((key) => key.target.startsWith('agent_')),
      table,
    ).toEqual([]);
  }
});

type CheckCase = { label: string; good: Row[]; bad: Row[] };
const RUN_CHECKS: CheckCase[] = [
  {
    label: 'final_event and ended_at are both NULL or both non-NULL',
    good: [{}, finished],
    bad: [
      { ...settled, final_event: terminal() },
      { ...settled, ended_at: LATER },
    ],
  },
  {
    label: 'final_event is exactly a type/data object with done/error and object data',
    good: [
      { ...finished, final_event: terminal('done') },
      { ...finished, final_event: terminal('error') },
    ],
    bad: [
      'null',
      '[]',
      '"done"',
      '1',
      'true',
      '{}',
      '{"data":{}}',
      '{"type":"done"}',
      '{"type":null,"data":{}}',
      '{"type":"done","data":null}',
      '{"type":"done","data":[]}',
      '{"type":"done","data":"text"}',
      '{"type":"unknown","data":{}}',
      '{"type":"DONE","data":{}}',
      '{"type":"done","data":{},"extra":1}',
    ].map((final_event) => ({ ...finished, final_event })),
  },
  {
    label: 'terminal event requires completed settlement',
    good: [finished],
    bad: [{ final_event: terminal(), ended_at: LATER, end_reason: 'stop' }],
  },
  {
    label: 'settle_result and settled_at are both NULL or both non-NULL',
    good: [{}, settled],
    bad: [
      { end_reason: 'stop', settle_result: 'counted' },
      { end_reason: 'stop', settled_at: AT },
    ],
  },
  {
    label: 'settlement requires an end_reason',
    good: [settled],
    bad: [{ settle_result: 'counted', settled_at: AT }],
  },
  {
    label: 'output_filtered exactly reflects nonempty filter_hits',
    good: [
      { output_filtered: false, filter_hits: [] },
      { output_filtered: true, filter_hits: ['url'] },
    ],
    bad: [
      { output_filtered: true, filter_hits: [] },
      { output_filtered: false, filter_hits: ['url'] },
    ],
  },
  {
    label: 'ended_at may equal but never precede accepted_at',
    good: [{ ...finished, ended_at: AT }, finished],
    bad: [{ ...finished, ended_at: BEFORE }],
  },
  {
    label: 'quota_subjects contains one or two non-NULL opaque subjects',
    good: [{ quota_subjects: ['subject-one'] }, { quota_subjects: ['subject-one', 'subject-two'] }],
    bad: [
      { quota_subjects: [] },
      { quota_subjects: ['a', 'b', 'c'] },
      { quota_subjects: [null] },
      { quota_subjects: ['subject-one', null] },
    ],
  },
];
for (const [index, example] of RUN_CHECKS.entries()) {
  it(`[AC-B3-09a#${22 + index}] runs CHECK: ${example.label}`, async () => {
    await requireTable('agent_runs');
    for (const value of example.good)
      expect(await sqlState(run(value)), JSON.stringify(value)).toBe(OK);
    for (const value of example.bad)
      expect(await sqlState(run(value)), JSON.stringify(value)).toBe(CHECK);
  });
}

for (const column of ['input_tokens', 'output_tokens', 'cost_mfen', 'ttft_ms', 'latency_ms']) {
  it(`[AC-B3-09a#30] runs.${column} accepts NULL/zero/positive and rejects negative`, async () => {
    await requireTable('agent_runs');
    for (const value of [null, 0n, 1n]) expect(await sqlState(run({ [column]: value }))).toBe(OK);
    expect(await sqlState(run({ [column]: -1n }))).toBe(CHECK);
  });
}

it('[AC-B3-09a#31] cost_mfen preserves bigint precision beyond JS safe integer', async () => {
  const row = await run({ cost_mfen: 9007199254740993n });
  expect((await read('agent_runs', row['id']))['cost_mfen']).toBe(9007199254740993n);
});

it('[AC-B3-09a#32] tool seq begins at 1 and latency is nullable/nonnegative', async () => {
  for (const values of [
    { seq: 1 },
    { seq: 2, latency_ms: 0 },
    { latency_ms: 1 },
    { latency_ms: null },
  ]) {
    expect(await sqlState(tool(values))).toBe(OK);
  }
  for (const values of [{ seq: 0 }, { seq: -1 }, { latency_ms: -1 }]) {
    expect(await sqlState(tool(values))).toBe(CHECK);
  }
});

it('[AC-B3-09a#33] session timestamps and card_seq enforce their lower boundaries', async () => {
  for (const values of [
    { last_active_at: AT, expired_at: null, card_seq: 0 },
    { last_active_at: LATER, expired_at: new Date('2026-10-07T08:00:00Z'), card_seq: 1 },
  ])
    expect(await sqlState(session(values))).toBe(OK);
  for (const values of [
    { last_active_at: BEFORE },
    { expired_at: AT },
    { expired_at: BEFORE },
    { card_seq: -1 },
  ])
    expect(await sqlState(session(values))).toBe(CHECK);
});

it('[AC-B3-09a#34] card_id and message card_ids use canonical positive c-prefixed numbers', async () => {
  for (const value of ['c1', 'c10', 'c999999'])
    expect(await sqlState(card({ card_id: value }))).toBe(OK);
  expect(await sqlState(message({ card_ids: [] }))).toBe(OK);
  expect(await sqlState(message({ card_ids: ['c1', 'c10', 'c999999'] }))).toBe(OK);
  for (const value of ['c0', 'C1', 'c01', '1', '', 'c-1', 'c1x', ' c1', 'c1\n']) {
    expect(await sqlState(card({ card_id: value })), value).toBe(CHECK);
    expect(await sqlState(message({ card_ids: ['c1', value] })), value).toBe(CHECK);
  }
  expect(await sqlState(message({ card_ids: ['c1', null] }))).toBe(CHECK);
});

const MESSAGE_CHECKS: CheckCase[] = [
  {
    label: 'feedback and feedback_at are paired',
    good: [{}, { feedback: 'up', feedback_at: AT }],
    bad: [{ feedback: 'up' }, { feedback_at: AT }],
  },
  {
    label: 'down feedback must be a badcase; badcase may also be set independently',
    good: [{ feedback: 'down', feedback_at: AT, badcase: true }, { badcase: true }],
    bad: [{ feedback: 'down', feedback_at: AT, badcase: false }],
  },
  {
    label: 'reported flag and timestamp are consistent',
    good: [{ reported: false }, { reported: true, reported_at: AT, report_status: 'pending' }],
    bad: [
      { reported: true, report_status: 'pending' },
      { reported: false, reported_at: AT },
    ],
  },
  {
    label: 'report_status is present exactly when reported',
    good: [{}, { reported: true, reported_at: AT, report_status: 'pending' }],
    bad: [
      { reported: true, reported_at: AT },
      { reported: false, report_status: 'pending' },
    ],
  },
  {
    label: 'user message requires both client_msg_id and run_id',
    good: [{ role: 'user', client_msg_id: 'client-id' }],
    bad: [{ role: 'user' }, { role: 'user', client_msg_id: 'client-id', run_id: null }],
  },
  {
    label: 'assistant message never carries client_msg_id',
    good: [{ role: 'assistant', client_msg_id: null }],
    bad: [{ role: 'assistant', client_msg_id: 'client-id' }],
  },
  {
    label: 'user messages have neither feedback nor reports',
    good: [{ role: 'user', client_msg_id: 'client-id' }],
    bad: [
      { role: 'user', client_msg_id: 'client-id', feedback: 'up', feedback_at: AT },
      {
        role: 'user',
        client_msg_id: 'client-id',
        reported: true,
        reported_at: AT,
        report_status: 'pending',
      },
    ],
  },
];
for (const [index, example] of MESSAGE_CHECKS.entries()) {
  it(`[AC-B3-09a#${35 + index}] messages CHECK: ${example.label}`, async () => {
    await requireTable('agent_messages');
    for (const value of example.good)
      expect(await sqlState(message(value)), JSON.stringify(value)).toBe(OK);
    for (const value of example.bad)
      expect(await sqlState(message(value)), JSON.stringify(value)).toBe(CHECK);
  });
}

it('[AC-B3-09a#42] handled reports require both handling time and handler, and vice versa', async () => {
  await requireTable('agent_messages');
  const adminId = await handler();
  const base = { reported: true, reported_at: AT, report_status: 'handled' };
  const handled = { report_handler_id: adminId, report_handled_at: LATER };
  expect(await sqlState(message({ ...base, ...handled }))).toBe(OK);
  for (const values of [
    { ...base },
    { ...base, report_handled_at: LATER },
    { ...base, report_handler_id: adminId },
    { ...base, ...handled, report_status: 'pending' },
  ])
    expect(await sqlState(message(values))).toBe(CHECK);
});

it('[AC-B3-09a#43] earnings_summary persists only as_of/actions and rejects every other top-level key', async () => {
  const data = { as_of: '2026-10-06T08:00:00Z', actions: [] };
  expect(await sqlState(card({ type: 'earnings_summary', data: JSON.stringify(data) }))).toBe(OK);
  for (const key of [
    'withdrawable_fen',
    'estimated_fen',
    'latest_withdrawal',
    'balance_fen',
    'amount',
    'extra',
  ]) {
    expect(
      await sqlState(
        card({ type: 'earnings_summary', data: JSON.stringify({ ...data, [key]: 100 }) }),
      ),
      key,
    ).toBe(CHECK);
  }
  expect(
    await sqlState(card({ type: 'notice', data: JSON.stringify({ message: 'synthetic' }) })),
  ).toBe(OK);
});

for (const [table, column, make] of [
  ['agent_cards', 'data', card],
  ['agent_result_sets', 'conditions', resultSet],
] as const) {
  it(`[AC-B3-09a#44] ${table}.${column} accepts JSON objects only`, async () => {
    await requireTable(table);
    for (const value of ['{}', '{"synthetic":"value"}'])
      expect(await sqlState(make({ [column]: value }))).toBe(OK);
    for (const value of ['null', '[]', '"text"', '123', 'true']) {
      expect(await sqlState(make({ [column]: value })), value).toBe(CHECK);
    }
  });
}

it('[AC-B3-09a#45] every stored card retains a nonempty fallback_text', async () => {
  expect(await sqlState(card({ fallback_text: 'synthetic fallback', schema_version: 2 }))).toBe(OK);
  expect(await sqlState(card({ fallback_text: '' }))).toBe(CHECK);
});

for (const [column, replacement] of [
  ['final_event', terminal('error')],
  ['ended_at', new Date('2026-10-06T08:02:00Z')],
  ['end_reason', 'cancelled'],
  ['settle_result', 'refunded'],
  ['settled_at', LATER],
] as const) {
  it(`[AC-B3-09a#46] runs.${column} is writable once, repeatable unchanged, never replaced or cleared`, async () => {
    const row = await run();
    expect(await sqlState(update('agent_runs', row['id'], finished))).toBe(OK);
    const before = await read('agent_runs', row['id']);
    expect(await sqlState(update('agent_runs', row['id'], finished))).toBe(OK);
    expect(await sqlState(update('agent_runs', row['id'], { [column]: replacement }))).toBe(
      REWRITE,
    );
    expect(await sqlState(update('agent_runs', row['id'], { [column]: null }))).toBe(REWRITE);
    expect(await read('agent_runs', row['id'])).toEqual(before);
  });
}

it('[AC-B3-09a#47] card_delivered cannot revert or change after settlement', async () => {
  const delivered = await run();
  expect(await sqlState(update('agent_runs', delivered['id'], { card_delivered: true }))).toBe(OK);
  expect(await sqlState(update('agent_runs', delivered['id'], { card_delivered: true }))).toBe(OK);
  expect(await sqlState(update('agent_runs', delivered['id'], { card_delivered: false }))).toBe(
    REWRITE,
  );
  const notDelivered = await run(settled);
  expect(await sqlState(update('agent_runs', notDelivered['id'], { card_delivered: true }))).toBe(
    REWRITE,
  );
  expect(await sqlState(update('agent_runs', notDelivered['id'], { card_delivered: false }))).toBe(
    OK,
  );
  expect((await read('agent_runs', notDelivered['id']))['card_delivered']).toBe(false);
  await update('agent_runs', delivered['id'], settled);
  expect(await sqlState(update('agent_runs', delivered['id'], { card_delivered: false }))).toBe(
    REWRITE,
  );
});

it('[AC-B3-09a#48] user_text can only be cleared, never replaced or restored', async () => {
  const row = await run({ user_text: 'synthetic redacted text' });
  expect(await sqlState(update('agent_runs', row['id'], { user_text: 'different text' }))).toBe(
    REWRITE,
  );
  expect(await sqlState(update('agent_runs', row['id'], { user_text: null }))).toBe(OK);
  expect(await sqlState(update('agent_runs', row['id'], { user_text: null }))).toBe(OK);
  expect(
    await sqlState(update('agent_runs', row['id'], { user_text: 'synthetic redacted text' })),
  ).toBe(REWRITE);
  expect((await read('agent_runs', row['id']))['user_text']).toBeNull();
  const initiallyNull = await run({ user_text: null });
  expect(
    await sqlState(update('agent_runs', initiallyNull['id'], { user_text: 'late trace' })),
  ).toBe(REWRITE);
});

it('[AC-B3-09a#49] card_seq can increase or stay unchanged but never decrease', async () => {
  const row = await session({ card_seq: 5 });
  expect(await sqlState(update('agent_sessions', row['id'], { card_seq: 8 }))).toBe(OK);
  expect(await sqlState(update('agent_sessions', row['id'], { card_seq: 8 }))).toBe(OK);
  expect(await sqlState(update('agent_sessions', row['id'], { card_seq: 7 }))).toBe(REWRITE);
  expect((await read('agent_sessions', row['id']))['card_seq']).toBe(8);
});

it('[AC-B3-09a#50] two connections reserve disjoint contiguous card ranges with atomic increments', async () => {
  const owner = await session();
  await app.connection().execute(async (left) => {
    await app.connection().execute(async (right) => {
      const pids = await Promise.all(
        [left, right].map((db) => sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db)),
      );
      expect(pids[0]!.rows[0]!.pid).not.toBe(pids[1]!.rows[0]!.pid);
      const reserve = async (db: Kysely<DB>, n: number) => {
        const result = await sql<{ first: number; last: number }>`
          UPDATE app.agent_sessions SET card_seq = card_seq + ${n} WHERE id = ${owner['id']}
          RETURNING card_seq - ${n} + 1 AS first, card_seq AS last`.execute(db);
        expect(result.rows).toHaveLength(1);
        const range = result.rows[0]!;
        expect(range.last - range.first + 1).toBe(n);
        return range;
      };
      const ranges = await Promise.all([reserve(left, 3), reserve(right, 5)]);
      ranges.sort((a, b) => a.first - b.first);
      expect(ranges[0]!.first).toBe(1);
      expect(ranges[0]!.last + 1).toBe(ranges[1]!.first);
      expect(ranges[1]!.last).toBe(8);
    });
  });
  expect((await read('agent_sessions', owner['id']))['card_seq']).toBe(8);
});

const RUN_IMMUTABLE = [
  'id',
  'app_id',
  'session_id',
  'prompt_version',
  'accepted_at',
  'quota_subjects',
  'created_at',
];
const UPDATABLE: Record<Table, string[]> = {
  agent_sessions: ['last_active_at', 'expired_at', 'card_seq', 'row_version', 'updated_at'],
  agent_runs: Object.keys(SHAPES.agent_runs).filter((name) => !RUN_IMMUTABLE.includes(name)),
  agent_messages: [
    'text',
    'card_ids',
    'feedback',
    'feedback_at',
    'reported',
    'report_reason',
    'reported_at',
    'report_status',
    'report_handler_id',
    'report_handled_at',
    'report_note',
    'badcase',
    'row_version',
    'updated_at',
  ],
  agent_tool_calls: [],
  agent_result_sets: [],
  agent_cards: [],
};
const FACTORIES: Record<Table, (values?: Row) => Promise<Row>> = {
  agent_sessions: session,
  agent_runs: run,
  agent_messages: message,
  agent_tool_calls: tool,
  agent_result_sets: resultSet,
  agent_cards: card,
};

for (const table of TABLES) {
  it(`[AC-B3-09a#51] couli_app has only prescribed UPDATE columns on ${table}`, async () => {
    await requireTable(table);
    for (const column of Object.keys(SHAPES[table])) {
      const result = await sql<{ allowed: boolean }>`SELECT has_column_privilege(
        'couli_app', ${`app.${table}`}, ${column}, 'UPDATE') AS allowed`.execute(app);
      expect(result.rows, `${table}.${column}`).toEqual([
        { allowed: UPDATABLE[table].includes(column) },
      ]);
    }
    const row = await FACTORIES[table]();
    const stored = await read(table, row['id']);
    // No-op assignments isolate privileges from CHECKs and rewrite triggers.
    for (const column of Object.keys(SHAPES[table]).filter(
      (name) => !UPDATABLE[table].includes(name),
    )) {
      expect(
        await sqlState(update(table, row['id'], { [column]: stored[column] })),
        `${table}.${column}`,
      ).toBe(DENIED);
    }
  });
}

it('[AC-B3-09a#52] couli_app updates all allowed session and message columns', async () => {
  const owner = await session();
  const sessionChanges = {
    last_active_at: LATER,
    expired_at: new Date('2026-10-07T08:00:00Z'),
    card_seq: 2,
    row_version: 1,
    updated_at: LATER,
  };
  expect(await sqlState(update('agent_sessions', owner['id'], sessionChanges))).toBe(OK);
  expect(await read('agent_sessions', owner['id'])).toMatchObject(sessionChanges);
  const reply = await message();
  const changes = {
    text: 'synthetic reply',
    card_ids: ['c1', 'c2'],
    feedback: 'down',
    feedback_at: AT,
    reported: true,
    report_reason: 'synthetic report',
    reported_at: AT,
    report_status: 'handled',
    report_handler_id: await handler(),
    report_handled_at: LATER,
    report_note: 'synthetic handling',
    badcase: true,
    row_version: 1,
    updated_at: LATER,
  };
  expect(await sqlState(update('agent_messages', reply['id'], changes))).toBe(OK);
  expect(await read('agent_messages', reply['id'])).toMatchObject(changes);
});

const PRIVATE_COLUMNS: Partial<Record<Table, string[]>> = {
  agent_runs: ['user_text'],
  agent_messages: ['text', 'report_reason'],
  agent_tool_calls: ['args'],
  agent_result_sets: ['conditions'],
};

for (const table of TABLES) {
  it(`[AC-B3-09a#53] ${table} is SELECT/INSERT for app, without DELETE/TRUNCATE`, async () => {
    await requireTable(table);
    for (const privilege of ['SELECT', 'INSERT', 'DELETE', 'TRUNCATE']) {
      const result = await sql<{ allowed: boolean }>`SELECT has_table_privilege(
        'couli_app', ${`app.${table}`}, ${privilege}) AS allowed`.execute(app);
      expect(result.rows, privilege).toEqual([
        { allowed: ['SELECT', 'INSERT'].includes(privilege) },
      ]);
    }
  });

  it(`[AC-B3-09a#54] readonly cannot SELECT private ${table} columns but can SELECT other columns`, async () => {
    await requireTable(table);
    for (const column of await columns(table)) {
      const result = await sql<{ allowed: boolean }>`SELECT has_column_privilege(
        'couli_readonly', ${`app.${table}`}, ${column.name}, 'SELECT') AS allowed`.execute(app);
      expect(result.rows, `${table}.${column.name}`).toEqual([
        {
          allowed: !(PRIVATE_COLUMNS[table] ?? []).includes(column.name),
        },
      ]);
    }
  });

  it(`[AC-B3-09a#55] payout and maint have no table or column privileges on ${table}`, async () => {
    await requireTable(table);
    for (const role of ['couli_payout', 'couli_maint']) {
      const tablePrivileges = await sql<{ allowed: boolean }>`SELECT has_table_privilege(
        ${role}, ${`app.${table}`}, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS allowed`.execute(
        app,
      );
      expect(tablePrivileges.rows, role).toEqual([{ allowed: false }]);
      const columnPrivileges = await sql<{ allowed: boolean }>`SELECT has_any_column_privilege(
        ${role}, ${`app.${table}`}, 'SELECT,INSERT,UPDATE,REFERENCES') AS allowed`.execute(app);
      expect(columnPrivileges.rows, role).toEqual([{ allowed: false }]);
    }
  });
}

it('[AC-B3-09a#56] accepted run and both messages survive settlement and terminal persistence; late trace remains writable', async () => {
  const owner = await session({ user_id: await newUser() });
  const pending = await run({}, owner);
  const request = await message({ role: 'user', client_msg_id: 'whole-chain-client-id' }, pending);
  const reply = await message({}, pending);
  const before = await sql<{ id: string; role: string; text: string | null }>`
    SELECT id, role, text FROM app.agent_messages WHERE app_id = 'couli' AND run_id = ${pending['id']}
    ORDER BY role`.execute(app);
  expect(before.rows).toEqual([
    { id: reply['id'], role: 'assistant', text: null },
    { id: request['id'], role: 'user', text: null },
  ]);
  expect(await sqlState(update('agent_runs', pending['id'], { end_reason: 'stop' }))).toBe(OK);
  expect(await sqlState(update('agent_runs', pending['id'], { card_delivered: true }))).toBe(OK);
  expect(
    await sqlState(
      update('agent_runs', pending['id'], { settle_result: 'counted', settled_at: AT }),
    ),
  ).toBe(OK);
  expect(
    await sqlState(
      update('agent_runs', pending['id'], { final_event: terminal(), ended_at: LATER }),
    ),
  ).toBe(OK);
  const trace = {
    user_text: null,
    intent: 'search',
    model: 'synthetic-model',
    model_snapshot: 'synthetic-snapshot',
    input_tokens: 12,
    output_tokens: 4,
    cost_mfen: 123456789012345n,
    ttft_ms: 20,
    latency_ms: 200,
    finish_reason: 'stop',
    filter_hits: ['amount', 'url'],
    output_filtered: true,
    output_truncated: true,
    price_version: 'synthetic-price@1',
    result_check_provider: 'rules',
    judge_model: 'synthetic-judge',
    page_guide_reject_reason: 'not_allowed',
    row_version: 1,
    updated_at: LATER,
  };
  expect(await sqlState(update('agent_runs', pending['id'], trace))).toBe(OK);
  expect(await read('agent_runs', pending['id'])).toMatchObject({
    ...trace,
    final_event: { type: 'done', data: {} },
    ended_at: LATER,
    ...settled,
    card_delivered: true,
    accepted_at: AT,
    prompt_version: 'synthetic@1',
  });
  expect(
    await sqlState(
      update('agent_messages', reply['id'], {
        text: 'synthetic completed reply',
        card_ids: ['c1'],
      }),
    ),
  ).toBe(OK);
  expect(await read('agent_messages', reply['id'])).toMatchObject({
    text: 'synthetic completed reply',
    card_ids: ['c1'],
  });
});
