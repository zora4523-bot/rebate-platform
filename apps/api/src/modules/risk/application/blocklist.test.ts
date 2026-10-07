// Unit tests of the blocklist service without a database (B1-03d round 2 review items): Kysely runs
// on a scripted driver that records every connection checkout, transaction boundary and compiled
// statement, to pin
//   - the risk_rules registration written with created_at and updated_at from the same Clock
//     instant as the risk_hits rows, never the columns' DEFAULT now();
//   - matchRegistration reading through the caller's transaction only: no write and no second
//     pooled connection while that transaction is open; the hits are written by recordHits after.
// The SQL itself runs against PostgreSQL in the rule tests (test/spec/risk/blocklist).
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
} from 'kysely';
import { expect, it } from 'vitest';
import { createRootLogger, type Clock, type FieldCrypto } from '../../platform/index.ts';
import { createBlocklistService } from './blocklist.ts';

const START_MS = Date.parse('2026-10-08T03:59:59.400Z');
const PHONE = '13812345678';
const DEVICE_HASH = 'b'.repeat(64);

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** Each read moves 700 ms on: a second read of the Clock would show in the rows. */
class SteppingClock implements Clock {
  private epochMs = START_MS;
  now(): Date {
    const instant = new Date(this.epochMs);
    this.epochMs += 700;
    return instant;
  }
}

/** Rows of an insert; `$n` placeholders resolve to parameters, anything else stays literal. */
function insertedRows(statement: Statement): Record<string, unknown>[] {
  const columns = /\(([^)]*)\) values/.exec(statement.sql)?.[1];
  if (columns === undefined) throw new Error('not an insert');
  const names = columns.split(',').map((column) => column.trim().replaceAll('"', ''));
  const values = statement.sql.slice(statement.sql.indexOf(') values') + ') values'.length);
  const section = values.split(' on conflict')[0] ?? '';
  return [...section.matchAll(/\(([^)]*)\)/g)].map((tuple) => {
    const cells = (tuple[1] ?? '').split(',').map((cell) => cell.trim());
    const row: Record<string, unknown> = {};
    names.forEach((name, index) => {
      const cell = cells[index] ?? '';
      const placeholder = /^\$(\d+)$/.exec(cell);
      row[name] = placeholder === null ? cell : statement.parameters[Number(placeholder[1]) - 1];
    });
    return row;
  });
}

function setup(blocked: readonly string[] = []) {
  const statements: Statement[] = [];
  const events: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const statement = { sql: compiled.sql, parameters: compiled.parameters };
      statements.push(statement);
      events.push(compiled.sql.split(' ')[0] ?? '');
      const hit =
        compiled.sql.startsWith('select') &&
        compiled.sql.includes('"blocklist"') &&
        compiled.parameters.some((parameter) => blocked.includes(String(parameter)));
      return Promise.resolve({
        rows: hit ? [{ violation_type: 'fraud_invite' }] : [],
      } as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => {
      events.push('acquire');
      return connection;
    },
    beginTransaction: async () => void events.push('begin'),
    commitTransaction: async () => void events.push('commit'),
    rollbackTransaction: async () => void events.push('rollback'),
    releaseConnection: async () => void events.push('release'),
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
  const crypto = {
    blindIndex: (value: string, context: string) => `hmac(${context}:${value})`,
  } as unknown as FieldCrypto;
  const service = createBlocklistService({
    db,
    clock: new SteppingClock(),
    crypto,
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  return { db, service, statements, events };
}

function inserts(statements: readonly Statement[], table: string): Record<string, unknown>[] {
  return statements
    .filter((statement) => statement.sql.startsWith(`insert into "app"."${table}"`))
    .flatMap(insertedRows);
}

it('[AC-B1-03d#13][BR-ID-36] risk_rules 补登记显式写 created_at 与 updated_at，与同次 risk_hits 同一 Clock 时刻', async () => {
  const { service, statements } = setup();
  await service.recordHit({
    app_id: 'couli',
    request_type: 'register',
    related_phone: PHONE,
    dimension: 'device',
    value_hmac: DEVICE_HASH,
    rule_id: 'DEVICE_REGISTER_LIMIT',
  });
  const [rule] = inserts(statements, 'risk_rules');
  const [hit] = inserts(statements, 'risk_hits');
  expect(rule?.rule_id).toBe('DEVICE_REGISTER_LIMIT');
  expect(rule?.created_at).toBeInstanceOf(Date);
  expect(rule?.updated_at).toBeInstanceOf(Date);
  const at = (hit?.created_at as Date).getTime();
  expect((rule?.created_at as Date).getTime()).toBe(at);
  expect((rule?.updated_at as Date).getTime()).toBe(at);
  const registration = statements.find((s) => s.sql.startsWith('insert into "app"."risk_rules"'));
  expect(registration?.sql).toContain('on conflict ("app_id", "rule_id") do nothing');
});

it('[AC-B1-03d#21][BR-ID-31/36] matchRegistration 只经调用方事务读：事务开着时不借第二个连接、不写；命中由 recordHits 事后写，共用编号', async () => {
  const { db, service, statements, events } = setup(['hmac(users.phone:13812345678)', DEVICE_HASH]);
  const block = await db.transaction().execute((trx) =>
    service.matchRegistration(trx, {
      app_id: 'couli',
      phone_hmac: 'hmac(users.phone:13812345678)',
      device_hash: DEVICE_HASH,
      related_phone: PHONE,
    }),
  );
  expect(block).toEqual({
    code: 44001,
    data: { risk_msg_code: 'blocklist.fraud_invite' },
    hits: [
      {
        dimension: 'phone',
        value_hmac: 'hmac(users.phone:13812345678)',
        rule_id: 'BLACKLIST_PHONE',
      },
      { dimension: 'device', value_hmac: DEVICE_HASH, rule_id: 'BLACKLIST_DEVICE' },
    ],
  });
  expect(events).toEqual(['acquire', 'begin', 'select', 'select', 'commit', 'release']);
  expect(statements.filter((s) => !s.sql.startsWith('select'))).toEqual([]);

  const { ref_id: refId } = await service.recordHits(
    { app_id: 'couli', request_type: 'register', related_phone: PHONE },
    block!.hits,
  );
  const rows = inserts(statements, 'risk_hits');
  expect(rows.map((row) => [row.dimension, row.rule_id, row.ref_id])).toEqual([
    ['phone', 'BLACKLIST_PHONE', refId],
    ['device', 'BLACKLIST_DEVICE', refId],
  ]);
  expect(rows.every((row) => row.user_id === null && row.request_type === 'register')).toBe(true);
  expect(rows[0]?.related_phone_masked).toBe('138****5678');
});

it('[AC-B1-03d#21] matchRegistration 未命中回 null；recordHits 不接受空命中', async () => {
  const { db, service, statements } = setup();
  expect(
    await db.transaction().execute((trx) =>
      service.matchRegistration(trx, {
        app_id: 'couli',
        phone_hmac: 'x',
        related_phone: PHONE,
      }),
    ),
  ).toBeNull();
  await expect(
    service.recordHits({ app_id: 'couli', request_type: 'register', related_phone: PHONE }, []),
  ).rejects.toThrow();
  expect(statements.filter((s) => !s.sql.startsWith('select'))).toEqual([]);
});
