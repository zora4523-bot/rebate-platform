// Unit tests of the taobao binding write's locks without a database (F1-07c, Codex money review
// r3): Kysely runs on a scripted driver that records each compiled statement and answers the
// user's taobao rows from a script, so a row created and reset between the pre-lock read and the
// lock can be staged. They pin what the rule tests cannot provoke on a real PostgreSQL:
// - S1: the new row_version is computed from the rows read under the user lock (a restore reads
//   again after the lock; a new row re-reads after its lock and moves its own row_version up);
// - S2: on every path the user lock (users FOR NO KEY UPDATE) comes before the conflict log's
//   advisory lock.
// The SQL itself runs against PostgreSQL in the rule tests (test/spec/linking/bindings,
// test/spec/linking/admin-union-bindings).
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
  type Transaction,
} from 'kysely';
import { expect, it, vi } from 'vitest';
import type { HandlerResult } from '../../platform/index.ts';
import { createUnionBindings, type UnionBindingsOptions } from './union-bindings.ts';

const APP = 'synthetic_app';
const USER = '019a0000-0000-7000-8000-0000000000a1';
const DEVICE = '019a0000-0000-7000-8000-0000000000d1';
const ACCOUNT = '019a0000-0000-7000-8000-0000000000b1';
const R_ID = '019a0000-0000-7000-8000-0000000000c1';
const S_ID = '019a0000-0000-7000-8000-0000000000c2';
const RELATION = 'synthetic-relation-r';
const NOW = new Date('2026-10-18T02:00:00.000Z');
const LATER = new Date('2026-10-25T02:00:00.000Z');
const TRACE = '019a0000-0000-7000-8000-0000000000ee';

type Row = Record<string, unknown>;

function binding(over: Row): Row {
  return {
    app_id: APP,
    user_id: USER,
    platform: 'taobao',
    union_account_id: ACCOUNT,
    relation_id: RELATION,
    status: 'active',
    bound_at: NOW,
    released_at: null,
    cooldown_until: null,
    blocked_reason: null,
    row_version: 0,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

/** R: the user's own released row of RELATION, still cooling. */
const COOLING_R = binding({
  id: R_ID,
  status: 'released',
  released_at: NOW,
  cooldown_until: LATER,
  row_version: 1,
});
/** S: created (version 2) and reset by the console (version 3) while the first read was stale. */
const RESET_S = binding({
  id: S_ID,
  relation_id: 'synthetic-relation-s',
  status: 'released',
  released_at: NOW,
  cooldown_until: LATER,
  row_version: 3,
});

function label(text: string): string {
  if (text.includes('pg_advisory_xact_lock')) return 'advisory';
  if (text.includes('from "users"') && text.includes('for no key update')) return 'user-lock';
  if (text.startsWith('insert into "union_bindings"')) return 'insert:bindings';
  if (text.startsWith('update "union_bindings"')) return 'update:bindings';
  if (text.startsWith('select') && text.includes('from "union_bindings"')) {
    return text.includes('"user_id" !=') ? 'select:others' : 'select:mine';
  }
  return `other:${text.split(' ')[0] ?? ''}`;
}

/** The value a compiled `update … set "<column>" = $n …` assigns to the column. */
function setValue(compiled: CompiledQuery, column: string): unknown {
  const set = compiled.sql.split(' where ')[0] ?? '';
  const match = new RegExp(`"${column}" = \\$(\\d+)`).exec(set);
  return match === null ? undefined : compiled.parameters[Number(match[1]) - 1];
}

interface Script {
  /** Each select:mine answers the next entry (the last one repeats). */
  readonly mine: readonly (readonly Row[])[];
  readonly others?: readonly Row[];
}

function setup(script: Script) {
  const statements: CompiledQuery[] = [];
  let mineReads = 0;
  let inserted: Row | undefined;
  const answer = (compiled: CompiledQuery): QueryResult<Row> => {
    const text = compiled.sql;
    switch (label(text)) {
      case 'select:others':
        return { rows: [...(script.others ?? [])] };
      case 'select:mine': {
        const rows = script.mine[Math.min(mineReads, script.mine.length - 1)] ?? [];
        mineReads += 1;
        return { rows: [...rows, ...(inserted === undefined ? [] : [inserted])] };
      }
      case 'user-lock':
        return { rows: [{ id: USER }] };
      case 'insert:bindings': {
        const columns = /\(([^)]*)\) values/.exec(text)?.[1]?.split(', ') ?? [];
        inserted = Object.fromEntries(
          columns.map((c, i) => [c.replaceAll('"', ''), compiled.parameters[i]]),
        );
        return { rows: [], numAffectedRows: 1n };
      }
      case 'update:bindings':
        return { rows: [], numAffectedRows: 1n };
      default:
        if (text.includes('from "devices"'))
          return { rows: [{ platform: 'ios', revoked_at: null }] };
        if (text.includes('from "union_auth_sessions"')) {
          return {
            rows: [
              {
                state: 'synthetic-state',
                app_id: APP,
                platform: 'taobao',
                mode: 'bind',
                used_at: null,
                expire_at: LATER,
                user_id: USER,
                device_id: DEVICE,
                client: 'ios',
                auth_methods: ['web_code'],
                auth_app_refs: { web_code: 'synthetic-app-ref' },
              },
            ],
          };
        }
        if (text.startsWith('update "union_auth_sessions"'))
          return { rows: [], numAffectedRows: 1n };
        return { rows: [], numAffectedRows: 0n };
    }
  };
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled);
      return Promise.resolve(answer(compiled) as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const warn = vi.fn();
  const options = {
    db,
    clock: { now: () => NOW },
    callerContext: {
      current: () => Promise.resolve({ appId: APP, userId: USER, deviceId: DEVICE }),
    },
    reads: {
      binding: () => Promise.resolve({ status: 'released', accountId: null }),
      userBanned: () => Promise.resolve(false),
      authAccountId: () => Promise.resolve(ACCOUNT),
      siteAuthAvailable: () => Promise.resolve(true),
      configuredMethods: () => Promise.resolve(['web_code']),
    },
    idempotency: {
      executeInTransaction: async (
        _request: unknown,
        handler: (trx: Transaction<DB>) => Promise<HandlerResult>,
      ) => {
        const result = await db.transaction().execute((trx) => handler(trx));
        return { status: result.status, body: JSON.stringify(result.envelope) };
      },
    },
    exchanger: {
      exchange: () => Promise.resolve({ kind: 'bound', relationId: RELATION }),
    },
    logger: { warn },
  } as unknown as UnionBindingsOptions;
  const service = createUnionBindings(options);
  const bind = () =>
    service.bind({
      platform: 'taobao',
      body: { state: 'synthetic-state', auth_method: 'web_code', code: 'synthetic-code' },
      idempotencyKey: '019a0000-0000-7000-8000-0000000000ff',
      traceId: TRACE,
    } as unknown as Parameters<typeof service.bind>[0]);
  const labels = (): string[] =>
    statements.map((s) => label(s.sql)).filter((l) => !l.startsWith('other:'));
  const updates = (): CompiledQuery[] =>
    statements.filter((s) => label(s.sql) === 'update:bindings');
  return { bind, labels, updates, warn, inserted: () => inserted };
}

/** Every advisory lock comes after a user lock already taken in the same transaction. */
function userLockFirst(labels: readonly string[]): boolean {
  const firstAdvisory = labels.indexOf('advisory');
  const firstUserLock = labels.indexOf('user-lock');
  return firstAdvisory === -1 || (firstUserLock !== -1 && firstUserLock < firstAdvisory);
}

it('[AC-F1-07c] restoring a cooling row reads the rows again under the user lock: its row_version passes a row created and reset meanwhile', async () => {
  // Read before the lock: only R (version 1). Under the lock: S was created (2) and reset (3).
  const f = setup({ mine: [[COOLING_R], [COOLING_R, RESET_S]] });
  const answer = await f.bind();
  expect(answer.envelope.code).toBe(0);
  const restore = f.updates().find((u) => setValue(u, 'status') === 'active');
  // Higher than every version S ever had: a console page still holding S's 2 (or 3) misses (20902).
  expect(setValue(restore!, 'row_version')).toBe(4);
  const labels = f.labels();
  expect(labels.indexOf('user-lock')).toBeLessThan(labels.lastIndexOf('select:mine'));
  expect(labels.lastIndexOf('select:mine')).toBeLessThan(labels.indexOf('update:bindings'));
  expect(userLockFirst(labels)).toBe(true);
});

it('[AC-F1-07c] a restore that finds an unreleased row under the lock decides again on the rows read under it', async () => {
  const S_ACTIVE = { ...RESET_S, status: 'active', released_at: null, cooldown_until: null };
  const f = setup({ mine: [[COOLING_R], [COOLING_R, S_ACTIVE]] });
  const answer = await f.bind();
  // S is unreleased with another relation id: 30151 rebind, R never restored.
  expect(answer.envelope.code).toBe(30151);
  expect(f.updates()).toEqual([]);
  expect(userLockFirst(f.labels())).toBe(true);
});

it('[AC-F1-07c] a new row re-reads under the user lock and moves its row_version past a row created and reset meanwhile', async () => {
  // Read before the insert: no row. Under the lock: S was created (2) and reset (3).
  const f = setup({ mine: [[], [RESET_S]] });
  const answer = await f.bind();
  expect(answer.envelope.code).toBe(0);
  const row = f.inserted();
  expect(row?.['row_version']).toBe(0);
  const moved = f.updates();
  expect(moved).toHaveLength(1);
  expect(setValue(moved[0]!, 'row_version')).toBe(4);
  expect(setValue(moved[0]!, 'status')).toBeUndefined();
  expect(moved[0]!.parameters).toContain(row?.['id']);
  const labels = f.labels();
  // Insert first (the B1-06h unique race), then user lock, re-read, move, advisory lock.
  expect(labels.indexOf('insert:bindings')).toBeLessThan(labels.indexOf('user-lock'));
  expect(labels.indexOf('user-lock')).toBeLessThan(labels.lastIndexOf('select:mine'));
  expect(labels.lastIndexOf('select:mine')).toBeLessThan(labels.indexOf('update:bindings'));
  expect(labels.indexOf('update:bindings')).toBeLessThan(labels.indexOf('advisory'));
  expect(userLockFirst(labels)).toBe(true);
});

it('[AC-F1-07c] a new row whose pre-insert version is still the highest is not rewritten', async () => {
  const f = setup({ mine: [[RESET_S], [RESET_S]] });
  const answer = await f.bind();
  expect(answer.envelope.code).toBe(0);
  expect(f.inserted()?.['row_version']).toBe(4);
  expect(f.updates()).toEqual([]);
  expect(userLockFirst(f.labels())).toBe(true);
});

it('[AC-F1-07c] an occupied relation takes the user lock before the conflict log advisory lock', async () => {
  const other = binding({ id: R_ID, user_id: '019a0000-0000-7000-8000-0000000000a9' });
  const f = setup({ mine: [[]], others: [other] });
  const answer = await f.bind();
  expect(answer.envelope.code).toBe(30151);
  const labels = f.labels();
  expect(labels).toContain('advisory');
  expect(userLockFirst(labels)).toBe(true);
});
