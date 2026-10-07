// B1-06m: an open holds one pooled connection for its transaction and never borrows a second one
// while it is open; the log of a result rolled back is wholly the opened link's.
// Real Kysely SQL compilation over an in-memory driver that counts connections; no socket.
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
import { afterEach, describe, expect, it } from 'vitest';
import type { CatalogCardEntry } from '../../catalog/index.ts';
import { FixedClock, type HandlerResult, type Idempotency } from '../../platform/index.ts';
import type { UnionPidService } from '../../union/index.ts';
import { openScopedConfig } from './link-open-reads.ts';
import {
  createLinkOpenRequote,
  type LinkOpenPrice,
  type LinkOpenRequoteOptions,
} from './link-open-requote.ts';

const APP = 'synthetic-app';
const USER_A = '0199a3b4-5c6d-7000-8000-00000000000a';
const USER_B = '0199a3b4-5c6d-7000-8000-00000000000b';
const LINK_A = '0199a3b4-5c6d-7000-8000-0000000000a1';
const NOW = '2031-05-06T07:00:00.000Z';

interface Seen {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly inTransaction: boolean;
}

/** Connections are unlimited, but one taken while an open's transaction is open is recorded. */
class CountingDriver implements Driver {
  held = 0;
  inTransaction = 0;
  readonly secondDuringTransaction: string[] = [];
  readonly seen: Seen[] = [];
  readonly rollbacks: number[] = [];
  readonly open = new Set<DatabaseConnection>();
  readonly respond: (query: CompiledQuery) => unknown[];
  /** Milliseconds a query waits before answering (a slow database), by query. */
  readonly delayMs: (query: CompiledQuery) => number;

  constructor(
    respond: (query: CompiledQuery) => unknown[],
    delayMs: (query: CompiledQuery) => number = () => 0,
  ) {
    this.respond = respond;
    this.delayMs = delayMs;
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    if (this.inTransaction > 0) this.secondDuringTransaction.push(`held ${this.held}`);
    this.held += 1;
    const connection: DatabaseConnection = {
      executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
        this.seen.push({
          sql: query.sql,
          parameters: query.parameters,
          inTransaction: this.open.has(connection),
        });
        const delay = this.delayMs(query);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        return { rows: this.respond(query) as R[], numAffectedRows: 1n };
      },
      streamQuery: () => {
        throw new Error('not streamed');
      },
    };
    return connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    this.open.add(connection);
    this.inTransaction += 1;
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    this.open.delete(connection);
    this.inTransaction -= 1;
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    this.open.delete(connection);
    this.inTransaction -= 1;
    this.rollbacks.push(1);
  }

  async releaseConnection(): Promise<void> {
    this.held -= 1;
  }

  async destroy(): Promise<void> {}
}

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

function linkA(clock: FixedClock) {
  const now = clock.now();
  const expired = clock.now();
  expired.setTime(now.getTime() - 60_000);
  return {
    link_id: LINK_A,
    app_id: APP,
    user_id: USER_A,
    device_id: null,
    platform: 'jd',
    product_key: 'jd:12345',
    raw_item_id: '12345',
    raw_fetched_at: now,
    scene: 'detail',
    sub_scene: null,
    pid_scene: 'self_buy',
    pid: 'synthetic-pid-a',
    entry_source: null,
    identity_snapshot: {
      user_id: USER_A,
      platform: 'jd',
      pid: 'synthetic-pid-a',
      pid_scene: 'self_buy',
      attr_code: 'demo000a',
      agent_session_id: null,
    },
    quoted_final_price_fen: 2990n,
    quoted_coupon_fen: 0n,
    quoted_coupon_id: null,
    quoted_at: now,
    expire_at: expired,
    agent_session_id: null,
    agent_card_id: null,
    convert_result: null,
    row_version: 0,
    created_at: now,
    updated_at: now,
  };
}

/** B opens A's link: the owner stage registers a link for B inside the transaction. */
function fixture(
  price: () => Promise<LinkOpenPrice>,
  faults: { readonly settingsFail?: boolean; readonly slowLinks?: boolean } = {},
) {
  const clock = new FixedClock(NOW);
  const original = linkA(clock);
  const isLinkRead = (query: CompiledQuery) =>
    query.sql.startsWith('select') && query.sql.includes('"links"');
  const driver = new CountingDriver(
    (query) => {
      if (query.sql.startsWith('select') && query.sql.includes('"links"')) return [original];
      if (query.sql.startsWith('insert into "links"')) {
        return [
          {
            ...original,
            link_id: '0199a3b4-5c6d-7000-8000-0000000000b1',
            user_id: USER_B,
            pid: 'synthetic-pid-b',
            expire_at: clock.now(),
          },
        ];
      }
      return [];
    },
    (query) => (faults.slowLinks === true && isLinkRead(query) ? 20 : 0),
  );
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  handles.push(db);
  // Readers backed by the same pool, as content's configuration and union's pids are.
  const poolRead = () => sql`select 1`.execute(db);
  const config = {
    configValue: async (appId: string, key: string) => {
      void appId;
      // A pool fault: every setting but the convert switch rejects at once.
      if (faults.settingsFail === true && key !== 'convert.enabled.jd') {
        throw new Error('synthetic settings connection failure');
      }
      await poolRead();
      return key === 'convert.enabled.jd' ? { value: true, version: 1 } : null;
    },
  };
  const pids: Pick<UnionPidService, 'getActivePid'> = {
    getActivePid: async (input) => {
      await poolRead();
      return {
        app_id: input.appId,
        platform: input.platform,
        pid_scene: input.pidScene,
        pid: 'synthetic-pid-b',
        status: 'active',
      } as Awaited<ReturnType<UnionPidService['getActivePid']>>;
    },
  };
  const attrCodes = {
    attrCode: async (appId: string, userId: string) => {
      void appId;
      await poolRead();
      return userId === USER_A ? 'demo000a' : 'demo000b';
    },
  };
  // The conversion port reads through linking's open-scoped reader, as createLinkOpenConversion.
  const conversionConfig = openScopedConfig(config);
  // Platform idempotency's transactional contract, minus its own records: one transaction per
  // open, rolled back for a result it does not store.
  const rollback = new Error('synthetic rollback');
  const idempotency: Pick<Idempotency, 'executeInTransaction'> = {
    executeInTransaction: async (_request, handler) => {
      let result: HandlerResult | undefined;
      try {
        await db.transaction().execute(async (trx) => {
          result = await handler(trx);
          const code = result.envelope.code;
          if (code !== 0 && (code < 30000 || code > 39999)) throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
      return { status: result!.status, body: JSON.stringify(result!.envelope), source: 'handler' };
    },
  };
  const catalog = {
    assemble: async () => ({
      kind: 'card',
      card: { link_id: LINK_A, rebate_min_fen: 100, rebate_max_fen: 100 },
    }),
  } as unknown as CatalogCardEntry;
  const options: LinkOpenRequoteOptions = {
    db,
    clock,
    callerContext: { current: async () => ({ appId: APP, userId: USER_B, deviceId: null }) },
    attrCodes,
    config,
    pids,
    catalog,
    prices: { fetch: price },
    conversion: {
      admit: async () => {
        await conversionConfig.configValue(APP, 'convert.enabled.jd');
      },
      convert: async () => ({
        primary: { type: 'h5', value: 'https://example.test/synthetic-jump' },
        fallbacks: [],
        expire_at: '2031-05-06T07:15:00.000Z',
      }),
      prepare: async (plan) => {
        await conversionConfig.configValue(plan.appId, 'convert.enabled.jd');
      },
    },
    cache: { get: async () => null, put: async () => undefined },
    idempotency,
  };
  const service = createLinkOpenRequote(options);
  const request = {
    linkId: LINK_A,
    idempotencyKey: 'synthetic-open-1',
    traceId: 'synthetic-trace',
    client: 'ios' as const,
  };
  return { service, driver, request };
}

/** The named columns and values of the last INSERT into a table. */
function lastInsert(
  seen: readonly Seen[],
  table: string,
): Readonly<Record<string, unknown>> & {
  readonly inTransaction: boolean;
} {
  const query = seen.filter((q) => q.sql.startsWith(`insert into "${table}"`)).at(-1);
  if (query === undefined) throw new Error(`no insert into ${table}`);
  const columns = /^insert into "[a-z_]+" \(([^)]*)\)/.exec(query.sql)![1]!;
  const names = columns.split(', ').map((name) => name.replaceAll('"', ''));
  const values: Record<string, unknown> = {};
  names.forEach((name, index) => {
    values[name] = query.parameters[index];
  });
  return { ...values, inTransaction: query.inTransaction };
}

describe('linking open connection use (B1-06m)', () => {
  it('[AC-B1-06m] an open for another user takes no second connection during its transaction', async () => {
    const f = fixture(async () => ({
      kind: 'available',
      input: {
        item: {
          platform: 'jd',
          final_price_fen: 2990n,
          coupon_fen: 0n,
          coupon_ids: '',
          quoted_at: NOW,
        },
        stale: false,
      } as unknown as Extract<LinkOpenPrice, { kind: 'available' }>['input'],
    }));
    const outcome = await f.service.open(f.request);
    expect(outcome.code).toBe(0);
    expect(f.driver.secondDuringTransaction).toEqual([]);
    // The owner stage did register B's link, inside the transaction.
    expect(lastInsert(f.driver.seen, 'links')).toMatchObject({
      inTransaction: true,
      user_id: USER_B,
    });
    expect(f.driver.held).toBe(0);
  });

  it('[AC-B1-06m] a 50303 open takes no second connection and logs the opened link as it is', async () => {
    const f = fixture(() => Promise.reject(new Error('synthetic price failure')));
    const outcome = await f.service.open(f.request);
    expect(outcome.code).toBe(50303);
    expect(f.driver.secondDuringTransaction).toEqual([]);
    expect(f.driver.rollbacks).toHaveLength(1);
    // Written after the rollback, wholly from A's link: no field of B's rolled-back link.
    expect(lastInsert(f.driver.seen, 'link_logs')).toMatchObject({
      inTransaction: false,
      link_id: LINK_A,
      user_id: USER_A,
      opener_user_id: USER_B,
      pid: 'synthetic-pid-a',
      pid_scene: 'self_buy',
      expired: true,
      result_code: 50303,
      quoted_price_fen: 2990n,
    });
  });

  it('[AC-B1-06m] a setting read that fails while the link is still read is never unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    let outcome: unknown;
    try {
      const f = fixture(() => Promise.reject(new Error('synthetic price failure')), {
        settingsFail: true,
        slowLinks: true,
      });
      outcome = await f.service.open(f.request).then(
        (value) => value,
        (error: unknown) => error,
      );
      // Let any rejection left without a handler be reported before looking.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(f.driver.held).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    // The failed setting fails the open where it is used, as when it was read in place.
    expect(outcome).toBeInstanceOf(Error);
  });
});
