import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { AliasNode, PostgresQueryCompiler, SelectQueryNode, TableNode, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { capture, order } from '../attribution/kit.ts';
import { built } from '../wiring/db-kit.ts';
import { config } from './db-kit.ts';
import { wired } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-08q#5] 生产配置按 App 和平台隔离，缺省 false/360，同一端口立即读到配置修改', async () => {
  const a = randomUUID();
  const b = randomUUID();
  const f = await wired(db);
  try {
    const read = (app: string, p: 'pdd' | 'jd' = 'pdd') =>
      built(() => f.sources.sourceConfig(app, p));
    expect(await read(a)).toEqual({ clickCodeEnabled: false, backfillWindowHours: 360 });
    await config(db, a, 'attr.click_code.pdd', true);
    await config(db, a, 'attr.backfill_window_hours', 480);
    await config(db, b, 'attr.click_code.jd', true);
    await config(db, b, 'attr.backfill_window_hours', 24);
    expect(await read(a)).toEqual({ clickCodeEnabled: true, backfillWindowHours: 480 });
    expect(await read(b)).toEqual({ clickCodeEnabled: false, backfillWindowHours: 24 });
    expect(await read(b, 'jd')).toEqual({ clickCodeEnabled: true, backfillWindowHours: 24 });
    expect(await read(a, 'jd')).toEqual({ clickCodeEnabled: false, backfillWindowHours: 480 });
    await config(db, a, 'attr.backfill_window_hours', 12);
    await config(db, a, 'attr.click_code.pdd', false);
    expect(await read(a)).toEqual({ clickCodeEnabled: false, backfillWindowHours: 12 });
  } finally {
    await f.context.close();
  }
});

it.each(['480', 0, -1, 1.5, null, true, 9007199254740992])(
  '[AC-B1-08q#6] 窗口非正安全整数 %s 回退 360h',
  async (value) => {
    const app = randomUUID();
    await config(db, app, 'attr.backfill_window_hours', value);
    const f = await wired(db);
    try {
      expect(await built(() => f.sources.sourceConfig(app, 'pdd'))).toEqual({
        clickCodeEnabled: false,
        backfillWindowHours: 360,
      });
    } finally {
      await f.context.close();
    }
  },
);

it.each(['true', 1, null, false, {}, []])(
  '[AC-B1-08q#7] 开关只接受 JSON true，%j 不能启用',
  async (value) => {
    const app = randomUUID();
    await config(db, app, 'attr.click_code.pdd', value);
    const f = await wired(db);
    try {
      expect(await built(() => f.sources.sourceConfig(app, 'pdd'))).toEqual({
        clickCodeEnabled: false,
        backfillWindowHours: 360,
      });
    } finally {
      await f.context.close();
    }
  },
);

it('[AC-B1-08q#8] 商品键每次从 catalog 读前缀，缺行/空前缀/不可推导返回 null', async () => {
  // couli_app cannot delete or re-prefix the pdd row seeded by migration 0017, so the scenarios
  // rewrite only that row in the results of queries on app.platforms (mechanical fixture fix,
  // D10-77 / D10-79): other tables and other platforms pass through untouched, and every read
  // must reach app.platforms (a cached prefix would miss the scenario changes below).
  let pdd: 'missing' | string | null = 'missing';
  let platformQueries = 0;
  const watched = new Map<unknown, boolean>();
  const tableOf = (from: unknown): string | undefined => {
    const node = AliasNode.is(from as never) ? (from as AliasNode).node : from;
    return TableNode.is(node as never) ? (node as TableNode).table.identifier.name : undefined;
  };
  const scenarioDb = db.withPlugin({
    transformQuery(args) {
      const node = args.node;
      if (
        SelectQueryNode.is(node) &&
        (node.from?.froms ?? []).some((from) => tableOf(from) === 'platforms')
      ) {
        platformQueries++;
        const { parameters } = new PostgresQueryCompiler().compileQuery(node, args.queryId);
        watched.set(args.queryId, parameters.includes('pdd'));
      }
      return node;
    },
    async transformResult(args) {
      const pddFiltered = watched.get(args.queryId);
      if (pddFiltered === undefined) return args.result;
      watched.delete(args.queryId);
      const rows = args.result.rows.flatMap((row) => {
        const record = row as Record<string, unknown>;
        const isPdd = 'code' in record ? record.code === 'pdd' : pddFiltered;
        if (!isPdd) return [row];
        if (pdd === 'missing') return [];
        return [{ ...record, key_prefix: pdd } as typeof row];
      });
      return { ...args.result, rows };
    },
  });
  const f = await wired(scenarioDb);
  try {
    const read = async (goods_id = '123', counted = true) => {
      const before = platformQueries;
      const key = await built(() =>
        f.sources.productKey({
          platform: 'pdd',
          order: order({ goods_id }),
        }),
      );
      if (counted) expect(platformQueries).toBeGreaterThan(before);
      return key;
    };
    expect(await read()).toBeNull();
    pdd = 'pp';
    expect(await read()).toBe('pp:123');
    pdd = 'px';
    expect(await read()).toBe('px:123');
    expect(await read('', false)).toBeNull();
    pdd = null;
    expect(await read()).toBeNull();
  } finally {
    await f.context.close();
  }
});

it('[AC-B1-08q#9] 京东端口没有 App 上下文，不能猜测 jdMode 推导商品键', async () => {
  // jd 行由迁移 0017 种下（key_prefix 'jd'），直接复用（mechanical fixture fix, D10-77）。
  const f = await wired(db);
  try {
    const incoming = { ...order({ platform: 'jd' }), itemId: 'x_123', skuId: '456' };
    expect(await built(() => f.sources.productKey({ platform: 'jd', order: incoming }))).toBeNull();
  } finally {
    await f.context.close();
  }
});

it.each(['config_items', 'platforms'] as const)(
  '[AC-B1-08q#10] 生产 %s 读取失败原样上抛，不转成缺省配置或 null',
  async (table) => {
    const failure = new Error(`synthetic ${table} read failure`);
    const failingDb = db.withPlugin({
      transformQuery(args) {
        const query = new PostgresQueryCompiler().compileQuery(args.node, args.queryId);
        if (query.sql.includes(`"${table}"`)) throw failure;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const f = await wired(failingDb);
    try {
      const result = await capture<unknown>(() =>
        table === 'config_items'
          ? f.sources.sourceConfig(randomUUID(), 'pdd')
          : f.sources.productKey({ platform: 'pdd', order: order() }),
      );
      expect(result).toEqual({ ok: false, error: failure });
      if (!result.ok) expect(result.error).toBe(failure);
    } finally {
      await f.context.close();
    }
  },
);
