// B1-10b 源码旁单元测试（Codex 资金评审 r2 S1）：受理与幂等记录同一事务。场景：用户以键 K 提交可找回的子订单
// S，受理已在事务里写好 claims / claim_items，进程在提交（COMMIT）前退出 → 事务整体回滚，claim 与幂等记录都
// 不在；同键同请求重试重新受理，得到 0 而不是 30205，也不计失败；之后同键原样重放。失败分支同理：计数已进
// Redis 而事务回滚，同键重试仍回原错误码、不再计数。
// 不连库：内存驱动按连接维护未提交写入（提交合并、回滚丢弃、支持 SAVEPOINT）；幂等是假实现，只模拟事务模式
// （记录与业务写同一事务，只存 0 与 3xxxx），标准模式 execute 一调用即失败。不连 Redis：假实现按计数脚本约定。
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it, vi } from 'vitest';
import type { ContentReader } from '../../../content/index.ts';
import {
  FixedClock,
  requestHashOf,
  type HandlerResult,
  type Idempotency,
  type IdempotentResponse,
  type RedisHandle,
  type RootLogger,
  type TokenPrincipal,
} from '../../../platform/index.ts';
import type { OrderClaimDeps } from '../../application/order-claims.ts';
import { OrderClaimsController, type OrderClaimsHttpRequest } from './order-claims.controller.ts';

const APP = 'claims_unit';
const USER = '019c0000-0000-7000-8000-000000000001';
const SUB = 'unit-sub-0001';
const COUNTER = `claim:${APP}:${USER}:20280115`;
const principal = {
  uid: USER,
  app_id: APP,
  sid: '019c0000-0000-7000-8000-000000000002',
  device_id: '019c0000-0000-7000-8000-000000000003',
  scp: 'full',
} as unknown as TokenPrincipal;
/** Unattributed, attributed 2028-01-15 00:10 +08:00: claimable at 2028-01-15T04:00Z with that date. */
const ORDER = {
  order_id: '019c0000-0000-7000-8000-0000000000aa',
  sub_order_id: SUB,
  buy_type: null,
  user_id: null,
  rebate_status: 'UNATTRIBUTED',
  locked: false,
  attr_at: new Date('2028-01-14T16:10:00.000Z'),
};

interface Writes {
  claims: number;
  items: string[];
  records: Map<string, { hash: string; response: { status: number; body: string } }>;
}
const emptyWrites = (): Writes => ({ claims: 0, items: [], records: new Map() });

class Crash extends Error {}

/**
 * The committed rows plus, per connection, its open transaction's writes. Reads see the committed
 * rows and the reader's own uncommitted writes; COMMIT merges, ROLLBACK discards.
 */
function memoryDb() {
  const committed = emptyWrites();
  type Connection = DatabaseConnection & { tx: Writes | null; marks: Map<string, Writes> };
  const copy = (w: Writes): Writes => ({
    claims: w.claims,
    items: [...w.items],
    records: new Map(w.records),
  });
  function run(conn: Connection, query: CompiledQuery): QueryResult<unknown> {
    const text = query.sql;
    const params = query.parameters as unknown[];
    const own = conn.tx ?? emptyWrites();
    const mark = /^(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT) (\w+)$/.exec(text);
    if (mark !== null) {
      if (conn.tx === null) throw new Error('savepoint outside a transaction');
      if (mark[1] === 'SAVEPOINT') conn.marks.set(mark[2]!, copy(conn.tx));
      else if (mark[1] === 'RELEASE SAVEPOINT') conn.marks.delete(mark[2]!);
      else conn.tx = copy(conn.marks.get(mark[2]!)!);
      return { rows: [] };
    }
    if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (text.startsWith('select') && text.includes('"app"."claims"')) {
      return { rows: [{ n: committed.claims + own.claims }] };
    }
    if (text.includes('"app"."orders"')) {
      const bySub = text.includes('"sub_order_id" is not null');
      return { rows: bySub && params.includes(SUB) ? [ORDER] : [] };
    }
    if (text.startsWith('select') && text.includes('"app"."claim_items"')) {
      const all = [...committed.items, ...own.items];
      return { rows: all.filter((s) => params.includes(s)).map((s) => ({ sub_order_id: s })) };
    }
    if (text.startsWith('insert into "app"."claims"')) {
      if (conn.tx === null) throw new Error('claims written outside a transaction');
      conn.tx.claims += 1;
      return { rows: [{ status: params.includes('submitted') ? 'submitted' : 'unknown' }] };
    }
    if (text.startsWith('insert into "app"."claim_items"')) {
      if (conn.tx === null) throw new Error('claim_items written outside a transaction');
      if ([...committed.items, ...conn.tx.items].includes(SUB) && params.includes(SUB)) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      if (params.includes(SUB)) conn.tx.items.push(SUB);
      return { rows: [] };
    }
    if (text.startsWith('select hash, response from fake_idempotency')) {
      const row = committed.records.get(params[0] as string);
      return { rows: row === undefined ? [] : [row] };
    }
    if (text.startsWith('insert into fake_idempotency')) {
      if (conn.tx === null) throw new Error('record written outside a transaction');
      const [key, hash, status, body] = params as [string, string, number, string];
      conn.tx.records.set(key, { hash, response: { status, body } });
      return { rows: [] };
    }
    throw new Error(`unexpected statement: ${text}`);
  }
  const driver: Driver = {
    init: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    acquireConnection(): Promise<DatabaseConnection> {
      const conn: Connection = {
        tx: null,
        marks: new Map(),
        executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          return Promise.resolve(run(conn, query) as QueryResult<R>);
        },
        streamQuery() {
          throw new Error('not used');
        },
      };
      return Promise.resolve(conn);
    },
    beginTransaction(connection: DatabaseConnection): Promise<void> {
      (connection as Connection).tx = emptyWrites();
      return Promise.resolve();
    },
    commitTransaction(connection: DatabaseConnection): Promise<void> {
      const tx = (connection as Connection).tx!;
      committed.claims += tx.claims;
      committed.items.push(...tx.items);
      for (const [key, row] of tx.records) committed.records.set(key, row);
      (connection as Connection).tx = null;
      return Promise.resolve();
    },
    rollbackTransaction(connection: DatabaseConnection): Promise<void> {
      (connection as Connection).tx = null;
      return Promise.resolve();
    },
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, committed };
}

/**
 * Platform idempotency's transactional mode, reduced to what this test needs: replay of a
 * committed record of the same body, else the handler on the transaction, the record of a 0 /
 * 3xxxx result written in that same transaction, anything else rolled back. `crashBeforeCommit`
 * ends the process between the handler and COMMIT (the transaction rolls back as a whole).
 */
function transactionalIdempotency(db: Kysely<DB>) {
  const state = { crashBeforeCommit: false };
  class Unstored extends Error {
    readonly response: IdempotentResponse;
    constructor(response: IdempotentResponse) {
      super('not stored');
      this.response = response;
    }
  }
  const idempotency: Idempotency = {
    execute: () => Promise.reject(new Error('standard mode must not be used')),
    async executeInTransaction(request, handler) {
      const hash = requestHashOf(request.body);
      try {
        return await db.transaction().execute(async (trx) => {
          const found = await sql<{
            hash: string;
            response: { status: number; body: string };
          }>`select hash, response from fake_idempotency where key = ${request.key}`.execute(trx);
          const row = found.rows[0];
          if (row !== undefined) {
            if (row.hash !== hash) throw new Error('another body under the same key');
            return { ...row.response, source: 'replay' as const };
          }
          const result: HandlerResult = await handler(trx);
          const response = {
            status: result.status,
            body: JSON.stringify(result.envelope),
            source: 'handler' as const,
          };
          const code = result.envelope.code;
          if (code !== 0 && (code < 30000 || code > 39999)) throw new Unstored(response);
          await sql`insert into fake_idempotency values (${request.key}, ${hash}, ${response.status}, ${response.body})`.execute(
            trx,
          );
          if (state.crashBeforeCommit) throw new Crash('process gone before COMMIT');
          return response;
        });
      } catch (error) {
        if (error instanceof Unstored) return error.response;
        throw error;
      }
    },
    abandon: () => Promise.reject(new Error('not used')),
    purgeExpired: () => Promise.reject(new Error('not used')),
  };
  return { idempotency, state };
}

/** The counting script's contract: a known mark adds nothing (0), else +1 and the mark is set. */
function fakeRedis(values: Map<string, string>): RedisHandle {
  return {
    namespace: (name) => ({
      get: async (key) => values.get(`${name}:${key}`) ?? null,
      set: async () => {
        throw new Error('set is not used');
      },
      eval: async (_script, options) => {
        const [counter, mark] = options.keys.map((key) => `${name}:${key}`);
        if (mark !== undefined && values.has(mark)) return 0;
        const reply = Number(values.get(counter!) ?? '0') + 1;
        values.set(counter!, String(reply));
        if (mark !== undefined) values.set(mark, '1');
        return reply;
      },
    }),
    close: async () => undefined,
    onApplicationShutdown: async () => undefined,
  };
}

function setup() {
  const { db, committed } = memoryDb();
  const { idempotency, state } = transactionalIdempotency(db);
  const values = new Map<string, string>();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as Record<string, unknown>;
  logger['child'] = () => logger;
  const config: ContentReader = {
    appVersion: async () => null,
    minSupportedVersion: async () => null,
    configValue: async () => null,
  };
  const deps: OrderClaimDeps = {
    db,
    redis: fakeRedis(values),
    clock: new FixedClock('2028-01-15T04:00:00.000Z'),
    config,
    logger: logger as unknown as RootLogger,
  };
  const controller = new OrderClaimsController(deps, idempotency);
  async function post(key: string, order_no = SUB) {
    const reply = { status: 0, body: '' };
    const raw = {
      code(status: number) {
        reply.status = status;
        return raw;
      },
      type: () => raw,
      send(payload: string) {
        reply.body = payload;
      },
    };
    const request = {
      id: '019c0000-0000-7000-8000-0000000000ff',
      principal,
      headers: { 'idempotency-key': key },
      body: { platform: 'jd', order_no, paid_date: '2028-01-15' },
    } as unknown as OrderClaimsHttpRequest;
    await controller.create(request, raw);
    return { ...reply, code: (JSON.parse(reply.body) as { code: number }).code };
  }
  return { committed, state, values, post };
}

it('[AC-B1-10b#39] 受理写入后、提交前进程退出：claim 与幂等记录一起回滚，同键重试受理成功而非 30205，不计失败', async () => {
  const s = setup();
  s.state.crashBeforeCommit = true;
  await expect(s.post('unit-key-0001')).rejects.toBeInstanceOf(Crash);
  expect(s.committed.claims).toBe(0);
  expect(s.committed.items).toEqual([]);
  expect(s.committed.records.size).toBe(0);
  s.state.crashBeforeCommit = false;
  const retry = await s.post('unit-key-0001');
  expect(retry).toMatchObject({ status: 200, code: 0 });
  expect(s.committed.claims).toBe(1);
  expect(s.committed.items).toEqual([SUB]);
  expect(s.values.get(COUNTER)).toBeUndefined();
  // The stored success replays byte for byte; nothing is judged or written again.
  const replay = await s.post('unit-key-0001');
  expect(replay.body).toBe(retry.body);
  expect(s.committed.claims).toBe(1);
  // Only another request meets the claim as a duplicate, and that one counts.
  expect(await s.post('unit-key-0002')).toMatchObject({ status: 422, code: 30205 });
  expect(s.values.get(COUNTER)).toBe('1');
  expect(s.committed.claims).toBe(1);
});

it('[AC-B1-10b#38] 失败已计入 Redis 而事务在提交前回滚：同键重试回原错误码且不再计数，之后原样重放', async () => {
  const s = setup();
  s.state.crashBeforeCommit = true;
  await expect(s.post('unit-key-0003', 'unit-missing')).rejects.toBeInstanceOf(Crash);
  expect(s.values.get(COUNTER)).toBe('1');
  expect(s.committed.records.size).toBe(0);
  s.state.crashBeforeCommit = false;
  const retry = await s.post('unit-key-0003', 'unit-missing');
  expect(retry).toMatchObject({ status: 404, code: 30201 });
  expect(s.values.get(COUNTER)).toBe('1');
  const replay = await s.post('unit-key-0003', 'unit-missing');
  expect(replay.body).toBe(retry.body);
  expect(s.values.get(COUNTER)).toBe('1');
  expect(s.committed.claims).toBe(0);
});
