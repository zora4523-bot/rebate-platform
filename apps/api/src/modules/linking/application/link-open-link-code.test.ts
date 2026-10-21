// B1-08s 源码旁单元测试：改价重新登记（B1-06k pending link）先转链、后写入时，返回的跳转地址携带的短码
// 必须就是该 link 行最终写入的 lk（或两者皆无）——写入时撞码就重抽并重新转链，用尽则不带短码重新转链、
// lk 写 NULL 并告警；同一单飞里另一个 open 已写入该 link 时按它写入的 lk 重新转链。
// 不连库：内存驱动按语句应答（Kysely 真实编译 SQL），撞码由应答模拟。
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
import { afterEach, expect, it, vi } from 'vitest';
import type { CatalogCardEntry } from '../../catalog/index.ts';
import { FixedClock, type HandlerResult, type Idempotency } from '../../platform/index.ts';
import type { UnionPidService } from '../../union/index.ts';
import { openRegistrationScope } from './link-registration.ts';
import {
  createLinkOpenRequote,
  type LinkOpenConversionInput,
  type LinkOpenPrice,
  type LinkOpenRequoteOptions,
} from './link-open-requote.ts';

const APP = 'synthetic-app';
const USER_A = '0199a3b4-5c6d-7000-8000-00000000000a';
const LINK_A = '0199a3b4-5c6d-7000-8000-0000000000a1';
const LINK_NEW = '0199a3b4-5c6d-7000-8000-0000000000c1';
const LINK_OTHER = '0199a3b4-5c6d-7000-8000-0000000000d1';
const NOW = '2031-05-06T07:00:00.000Z';
const QUOTED = '2031-05-05T07:00:00.000Z';

interface Seen {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** Answers each statement by its SQL; begin / commit / rollback are only counted. */
class ScriptedDriver implements Driver {
  readonly seen: Seen[] = [];
  readonly rollbacks: number[] = [];
  readonly commits: number[] = [];
  readonly respond: (query: CompiledQuery) => unknown[];

  constructor(respond: (query: CompiledQuery) => unknown[]) {
    this.respond = respond;
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return {
      executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
        this.seen.push({ sql: query.sql, parameters: query.parameters });
        return { rows: this.respond(query) as R[], numAffectedRows: 1n };
      },
      streamQuery: () => {
        throw new Error('not streamed');
      },
    };
  }

  async beginTransaction(): Promise<void> {}

  async commitTransaction(): Promise<void> {
    this.commits.push(1);
  }

  async rollbackTransaction(): Promise<void> {
    this.rollbacks.push(1);
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

function linkA(clock: FixedClock) {
  const now = clock.now();
  const expire = clock.now();
  expire.setTime(now.getTime() + 600_000);
  return {
    link_id: LINK_A,
    app_id: APP,
    user_id: USER_A,
    device_id: null,
    platform: 'jd',
    product_key: 'jd:12345',
    raw_item_id: '12345',
    raw_fetched_at: new FixedClock(QUOTED).now(),
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
    quoted_at: new FixedClock(QUOTED).now(),
    expire_at: expire,
    agent_session_id: null,
    agent_card_id: null,
    convert_result: null,
    lk: null,
    row_version: 0,
    created_at: now,
    updated_at: now,
  };
}

interface Script {
  /** Codes the pre-check finds already taken (select … where lk = …). */
  readonly taken?: readonly string[];
  /** Codes whose insert collides on (app_id, lk) (empty result, no row with the link_id). */
  readonly collide?: readonly string[];
  /** The renewed link already written by another open of the flight, with this lk. */
  readonly writtenByOther?: string | null;
  /** attr.click_code.jd (JSON true by default). */
  readonly clickCode?: unknown;
  /** The conversion fails from this call on (1-based). */
  readonly failFromCall?: number;
}

/**
 * USER_A opens their own JD link (owner stage: use); the re-check prices 3090 against 2990, so
 * the card registers a renewed snapshot (B1-06k pending link) that the open writes itself.
 */
function fixture(codes: readonly string[], script: Script = {}) {
  const clock = new FixedClock(NOW);
  const original = linkA(clock);
  const known = new Set(codes);
  const codeIn = (query: CompiledQuery): string | null =>
    (query.parameters.find((value) => typeof value === 'string' && known.has(value)) as
      string | undefined) ?? null;
  const driver = new ScriptedDriver((query) => {
    const text = query.sql;
    if (text.startsWith('select "link_id" from "links"') && text.includes('"lk" = ')) {
      const code = codeIn(query);
      return code !== null && script.taken?.includes(code) === true
        ? [{ link_id: LINK_OTHER }]
        : [];
    }
    if (text.startsWith('select "link_id", "lk" from "links"')) {
      return script.writtenByOther === undefined
        ? []
        : [{ link_id: LINK_NEW, lk: script.writtenByOther }];
    }
    if (text.startsWith('select') && text.includes('"links"')) return [original];
    if (text.startsWith('insert into "links"')) {
      if (script.writtenByOther !== undefined) return [];
      const code = codeIn(query);
      if (code !== null && script.collide?.includes(code) === true) return [];
      return [{ ...original, link_id: LINK_NEW, quoted_final_price_fen: 3090n, lk: code }];
    }
    return [];
  });
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  handles.push(db);
  const settings = new Map<string, unknown>([
    ['convert.enabled.jd', true],
    ['attr.click_code.jd', 'clickCode' in script ? script.clickCode : true],
  ]);
  const config = {
    configValue: async (_appId: string, key: string) =>
      settings.has(key)
        ? { value: settings.get(key) as DB['config_items']['value'], version: 1 }
        : null,
  };
  const pids: Pick<UnionPidService, 'getActivePid'> = {
    getActivePid: async (input) =>
      ({
        app_id: input.appId,
        platform: input.platform,
        pid_scene: input.pidScene,
        pid: 'synthetic-pid-a',
        status: 'active',
      }) as Awaited<ReturnType<UnionPidService['getActivePid']>>,
  };
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
  // The card registers the renewed snapshot inside the open's registration scope, as catalog's
  // registrar does through linking (deferForOpen).
  const catalog = {
    assemble: async () => {
      const scope = openRegistrationScope.getStore();
      if (scope === undefined) throw new Error('no open registration scope');
      scope.pending = {
        now: clock.now(),
        caller: scope.owner,
        linkId: LINK_NEW,
        snapshot: scope.snapshot,
        shopId: null,
        values: {
          platform: 'jd',
          productKey: 'jd:12345',
          rawItemId: '12345',
          rawFetchedAt: NOW,
          scene: scope.scene,
          subScene: scope.subScene,
          entrySource: null,
          quotedFinalPriceFen: 3090n,
          quotedCouponFen: 0n,
          quotedCouponId: null,
          quotedAt: NOW,
          agentCardId: scope.agentCardId,
        },
      };
      return {
        kind: 'card',
        card: { link_id: LINK_NEW, rebate_min_fen: 100, rebate_max_fen: 100 },
      };
    },
  } as unknown as CatalogCardEntry;
  const price: LinkOpenPrice = {
    kind: 'available',
    input: {
      item: {
        platform: 'jd',
        final_price_fen: 3090n,
        coupon_fen: 0n,
        coupon_ids: '',
        quoted_at: NOW,
      },
      stale: false,
    } as unknown as Extract<LinkOpenPrice, { kind: 'available' }>['input'],
  };
  const converted: (string | null | undefined)[] = [];
  const convert = vi.fn(async (input: LinkOpenConversionInput) => {
    converted.push(input.linkCode);
    if (script.failFromCall !== undefined && converted.length >= script.failFromCall) {
      throw Object.assign(new Error('synthetic conversion failure'), { code: 50303 });
    }
    return {
      primary: {
        type: 'h5' as const,
        value: `https://example.test/jump?lk=${input.linkCode ?? '-'}`,
      },
      fallbacks: [],
      expire_at: '2031-05-06T07:15:00.000Z',
    };
  });
  const linkCode = vi.fn<() => string>();
  for (const code of codes) linkCode.mockReturnValueOnce(code);
  linkCode.mockImplementation(() => {
    throw new Error('no further draw expected');
  });
  const error = vi.fn();
  const options: LinkOpenRequoteOptions & {
    readonly logger: { error: typeof error; warn(): void };
  } = {
    db,
    clock,
    callerContext: { current: async () => ({ appId: APP, userId: USER_A, deviceId: null }) },
    attrCodes: { attrCode: async () => 'demo000a' },
    config,
    pids,
    catalog,
    prices: { fetch: async () => price },
    conversion: { convert },
    cache: { get: async () => null, put: async () => undefined },
    idempotency,
    linkCode,
    logger: { error, warn: () => undefined },
  };
  const service = createLinkOpenRequote(options);
  const request = {
    linkId: LINK_A,
    idempotencyKey: 'synthetic-open-1',
    traceId: 'synthetic-trace',
    client: 'h5' as const,
  };
  /** The lk of every links insert, in order (null: written without a code). */
  const inserts = () =>
    driver.seen
      .filter((query) => query.sql.startsWith('insert into "links"'))
      .map(
        (query) =>
          (query.parameters.find((value) => typeof value === 'string' && known.has(value)) as
            string | undefined) ?? null,
      );
  return { service, request, driver, converted, linkCode, error, inserts };
}

/** The code the answered jump carries (null: none). */
function jumpCode(outcome: Awaited<ReturnType<ReturnType<typeof fixture>['service']['open']>>) {
  const value = outcome.data?.jump.primary.value ?? '';
  const code = new URL(value).searchParams.get('lk');
  return code === '-' ? null : code;
}

it('[AC-B1-08s#u20] 未撞码：转链与写入同一个预抽码，只转一次', async () => {
  const f = fixture(['same01']);
  const outcome = await f.service.open(f.request);
  expect(outcome.code).toBe(0);
  expect(outcome.data?.new_link_id).toBe(LINK_NEW);
  expect(f.converted).toEqual(['same01']);
  expect(f.inserts()).toEqual(['same01']);
  expect(jumpCode(outcome)).toBe('same01');
  expect(f.linkCode).toHaveBeenCalledTimes(1);
  expect(f.error).not.toHaveBeenCalled();
});

it('[AC-B1-08s#u21] 预抽码转链后被别的 link 抢占：写入时重抽，按写入的新码重新转链，返回地址带新码', async () => {
  const f = fixture(['race01', 'race02'], { collide: ['race01'] });
  const outcome = await f.service.open(f.request);
  expect(outcome.code).toBe(0);
  expect(f.converted).toEqual(['race01', 'race02']);
  expect(f.inserts()).toEqual(['race01', 'race02']);
  expect(jumpCode(outcome)).toBe('race02');
  expect(jumpCode(outcome)).toBe(f.inserts().at(-1));
  expect(f.driver.rollbacks).toEqual([]);
  expect(f.error).not.toHaveBeenCalled();
});

it('[AC-B1-08s#u22] 写入时首次加三次重抽都撞：lk 写 NULL 并告警一次，按不带短码重新转链', async () => {
  const codes = ['full01', 'full02', 'full03', 'full04'];
  const f = fixture(codes, { collide: codes });
  const outcome = await f.service.open(f.request);
  expect(outcome.code).toBe(0);
  expect(f.converted).toEqual(['full01', null]);
  expect(f.inserts()).toEqual([...codes, null]);
  expect(jumpCode(outcome)).toBeNull();
  expect(f.linkCode).toHaveBeenCalledTimes(4);
  expect(f.error).toHaveBeenCalledTimes(1);
  expect(f.error.mock.calls[0]![0]).toEqual({
    event: 'linking.link_code.exhausted',
    app_id: APP,
    platform: 'jd',
  });
  expect(f.driver.rollbacks).toEqual([]);
});

it('[AC-B1-08s#u23] 预检已用掉的抽号计入 4 次：第 4 次预检空闲但写入撞码时不再重抽，写 NULL 并不带短码转链', async () => {
  const codes = ['pre001', 'pre002', 'pre003', 'pre004'];
  const f = fixture(codes, { taken: ['pre001', 'pre002', 'pre003'], collide: ['pre004'] });
  const outcome = await f.service.open(f.request);
  expect(outcome.code).toBe(0);
  expect(f.converted).toEqual(['pre004', null]);
  expect(f.inserts()).toEqual(['pre004', null]);
  expect(jumpCode(outcome)).toBeNull();
  expect(f.linkCode).toHaveBeenCalledTimes(4);
  expect(f.error).toHaveBeenCalledTimes(1);
});

it('[AC-B1-08s#u24] 同一单飞的另一个 open 已用别的码写入该 link：按已写入的码重新转链，不再写入', async () => {
  const f = fixture(['mine01', 'them01'], { writtenByOther: 'them01' });
  const outcome = await f.service.open(f.request);
  expect(outcome.code).toBe(0);
  expect(f.converted).toEqual(['mine01', 'them01']);
  expect(f.inserts()).toEqual(['mine01']);
  expect(jumpCode(outcome)).toBe('them01');
  expect(f.linkCode).toHaveBeenCalledTimes(1);
});

it('[AC-B1-08s#u25] 另一个 open 已写入的 link 没有短码：不带短码重新转链（两者皆无）', async () => {
  const f = fixture(['mine02'], { writtenByOther: null });
  const outcome = await f.service.open(f.request);
  expect(outcome.code).toBe(0);
  expect(f.converted).toEqual(['mine02', null]);
  expect(jumpCode(outcome)).toBeNull();
});

it('[AC-B1-08s#u26] 开关不是 JSON true：不抽号，转链与写入都不带短码，只转一次', async () => {
  const f = fixture(['unused'], { clickCode: 'on' });
  const outcome = await f.service.open(f.request);
  expect(outcome.code).toBe(0);
  expect(f.converted).toEqual([null]);
  expect(f.inserts()).toEqual([null]);
  expect(jumpCode(outcome)).toBeNull();
  expect(f.linkCode).not.toHaveBeenCalled();
});

it('[AC-B1-08s#u27] 按写入的码重新转链失败：整笔 open 回滚为 50303，不返回带旧码的地址', async () => {
  const f = fixture(['fail01', 'fail02'], { collide: ['fail01'], failFromCall: 2 });
  const outcome = await f.service.open(f.request);
  expect(outcome).toEqual({ code: 50303, data: null });
  expect(f.converted).toEqual(['fail01', 'fail02']);
  expect(f.driver.rollbacks).toHaveLength(1);
});
