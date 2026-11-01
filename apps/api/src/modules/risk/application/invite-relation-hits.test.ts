// Unit tests of the invite-relation hit writer's statement shape without a database (B1-03x):
// Kysely compiles against a dummy driver and a plugin records every statement. The SQL itself runs
// against PostgreSQL in the rule tests (test/spec/risk/invite-hits).
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  createInviteRelationHitWriter,
  type InviteRelationHitInput,
} from './invite-relation-hits.ts';

const AT = '2026-10-18T03:04:05.678Z';
const HASH = 'ab'.repeat(32);
const USER = '00000000-0000-4000-8000-000000000001';

function recordingDb(): { db: Kysely<DB>; queries: CompiledQuery[] } {
  const queries: CompiledQuery[] = [];
  const compiler = new PostgresQueryCompiler();
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => new DummyDriver(),
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [
      {
        transformQuery(args) {
          queries.push(compiler.compileQuery(args.node, args.queryId));
          return args.node;
        },
        async transformResult(args) {
          return args.result;
        },
      },
    ],
  });
  return { db, queries };
}

async function run(input: InviteRelationHitInput, clock = new FixedClock(AT)) {
  const { db, queries } = recordingDb();
  const writer = createInviteRelationHitWriter({ clock });
  try {
    let error: unknown;
    await db.transaction().execute(async (trx) => {
      try {
        await writer.record(trx, input);
      } catch (caught) {
        error = caught;
      }
    });
    return { queries, error };
  } finally {
    await db.destroy();
  }
}

const base = { app_id: 'app_a', user_id: USER, value_hmac: HASH } as const;

it.each([
  ['inv_08_self', 'device_id_hash'],
  ['inv_08_descendant', 'device_id_hash'],
  ['inv_08_same_device', 'user_id'],
  ['inv_09_same_device', 'user_id'],
  ['inv_08_self', 'device'],
  ['inv_09_same_device', ''],
] as const)('[AC-B1-03x#1] 规则 %s 配维度 %s 不符：发 SQL 前抛 TypeError', async (rule, dim) => {
  const { queries, error } = await run({
    ...base,
    rule_id: rule,
    dimension: dim as InviteRelationHitInput['dimension'],
  });
  expect(error).toBeInstanceOf(TypeError);
  expect(queries).toEqual([]);
});

it.each(['app_id', 'user_id', 'value_hmac'] as const)(
  '[AC-B1-03x#1] %s 为空串或非字符串：发 SQL 前抛 TypeError',
  async (field) => {
    for (const bad of ['', null, 7]) {
      const { queries, error } = await run({
        ...base,
        rule_id: 'inv_08_self',
        dimension: 'user_id',
        [field]: bad,
      } as unknown as InviteRelationHitInput);
      expect(error).toBeInstanceOf(TypeError);
      expect(queries).toEqual([]);
    }
  },
);

it('[AC-B1-03x#2][AC-B1-03x#3] 先登记规则（ON CONFLICT (app_id, rule_id) DO NOTHING，不先查），再插命中；时间与 id 取自 Clock', async () => {
  const clock = new FixedClock(AT);
  const now = clock.now();
  const { queries, error } = await run(
    { ...base, rule_id: 'inv_09_same_device', dimension: 'device_id_hash' },
    clock,
  );
  expect(error).toBeUndefined();
  const writes = queries.filter((q) => !/^(begin|commit|rollback|select)/i.test(q.sql));
  expect(writes).toHaveLength(2);
  const [rule, hit] = writes as [CompiledQuery, CompiledQuery];
  expect(rule.sql).toMatch(/^insert into "app"\."risk_rules"/);
  expect(rule.sql).toContain('on conflict ("app_id", "rule_id") do nothing');
  expect(rule.sql).toContain(`'{}'::jsonb`);
  const id = rule.parameters[0] as string;
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(now.getTime());
  expect(rule.parameters.slice(1)).toEqual([
    'app_a',
    'inv_09_same_device',
    'invite_relation',
    'block',
    'active',
    1,
    now,
    now,
  ]);
  expect(hit.sql).toMatch(/^insert into "app"\."risk_hits"/);
  expect(hit.sql).not.toContain('on conflict');
  expect(hit.parameters).toEqual([
    'app_a',
    USER,
    'inv_09_same_device',
    'block',
    'device_id_hash',
    HASH,
    'invite_relation',
    USER,
    now,
  ]);
});

it('[AC-B1-03zh#17][BR-ID-36] 规则停用：只读规则状态，不登记规则、不写命中', async () => {
  const queries: CompiledQuery[] = [];
  const compiler = new PostgresQueryCompiler();
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => new DummyDriver(),
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [
      {
        transformQuery(args) {
          queries.push(compiler.compileQuery(args.node, args.queryId));
          return args.node;
        },
        async transformResult(args) {
          // The rule status read answers disabled; nothing else is read.
          return queries.at(-1)?.sql.startsWith('select "status" from "app"."risk_rules"')
            ? { ...args.result, rows: [{ status: 'disabled' }] }
            : args.result;
        },
      },
    ],
  });
  try {
    const writer = createInviteRelationHitWriter({ clock: new FixedClock(AT) });
    await db.transaction().execute(async (trx) => {
      await writer.record(trx, { ...base, rule_id: 'inv_08_self', dimension: 'user_id' });
    });
    const statements = queries.filter((q) => !/^(begin|commit|rollback)/i.test(q.sql));
    expect(statements.map((q) => q.sql)).toEqual([
      'select "status" from "app"."risk_rules" where "app_id" = $1 and "rule_id" = $2',
    ]);
    expect(statements[0]!.parameters).toEqual(['app_a', 'inv_08_self']);
  } finally {
    await db.destroy();
  }
});

it('[AC-B1-03zh#21][BR-ID-36] decided_in_force：调用方判定已按生效解除归属，写命中不再读规则状态，照写规则与命中', async () => {
  const { db, queries } = recordingDb();
  let statusReads = 0;
  const writer = createInviteRelationHitWriter({
    clock: new FixedClock(AT),
    rules: {
      isEnabled() {
        statusReads += 1;
        return Promise.resolve(false);
      },
    },
  });
  try {
    await db.transaction().execute(async (trx) => {
      await writer.record(trx, {
        ...base,
        rule_id: 'inv_09_same_device',
        dimension: 'device_id_hash',
        decided_in_force: true,
      });
    });
    const statements = queries.filter((q) => !/^(begin|commit|rollback)/i.test(q.sql));
    expect(statusReads).toBe(0);
    expect(statements.map((q) => q.sql.split(' (')[0])).toEqual([
      'insert into "app"."risk_rules"',
      'insert into "app"."risk_hits"',
    ]);
    // Without the decision the same writer reads the status and writes nothing.
    queries.length = 0;
    await db.transaction().execute(async (trx) => {
      await writer.record(trx, {
        ...base,
        rule_id: 'inv_09_same_device',
        dimension: 'device_id_hash',
      });
    });
    expect(statusReads).toBe(1);
    expect(queries.filter((q) => q.sql.startsWith('insert'))).toEqual([]);
  } finally {
    await db.destroy();
  }
});
