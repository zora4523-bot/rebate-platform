// Rule tests for createMaintDbHandle without a database (task B1-01n; contract section 3 of
// apps/api/src/modules/platform/db/maint.ts, which applies sections 4, 6 and 7 of the db contract to
// the maintenance pool). Basis: ADR-0001 §4.2 第 4、8 项 (couli_maint), 第 11 项 (连接池); 规划/02 §12.6
// (口令不回显). The URLs point at 127.0.0.1:1, where nothing listens; every test counts the
// connection attempts of all sockets of the process, which must stay 0. Unit tests: no database,
// no port. Top-level it() only (规划/11 §4.3).
import { inspect } from 'node:util';
import { sql, Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { loadConnectionConfig } from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  createMaintDbHandle,
  loadMaintConnectionConfig,
  type MaintConnectionConfig,
  type MaintDbHandle,
} from '../../../../apps/api/src/modules/platform/db/maint.ts';
import {
  dbErrorProblems,
  describeError,
  leaksIn,
  memoryLogger,
  phraseOf,
  rejectionProblems,
  turns,
  urlsOf,
  watchSocketConnects,
} from './kit.ts';
import { MAINT_VAR, maintUrlOf } from './maint-kit.ts';

/** The maintenance config of the worker for the URL of `label` (throws what the loader throws). */
function configOf(label: string): MaintConnectionConfig {
  const config = loadMaintConnectionConfig('worker', {
    APP_ENV: 'prod',
    [MAINT_VAR]: maintUrlOf(label),
  });
  if (config === null) throw new Error('loader returned null for a set URL');
  return config;
}

function kyselyView(value: unknown): unknown {
  if (!(value instanceof Kysely)) return `not a Kysely instance: ${String(value)}`;
  return {
    prototype: Object.getPrototypeOf(value) === Kysely.prototype,
    ownKeys: Reflect.ownKeys(value).map(String),
  };
}

async function closeOutcome(handle: MaintDbHandle): Promise<string> {
  try {
    return `resolved ${String(await handle.close())}`;
  } catch (error) {
    return describeError(error);
  }
}

/** Every way of asking the handle for a connection, as promises (created when called). */
function requests(db: MaintDbHandle['db']): Promise<unknown>[] {
  return [
    sql`SELECT app.partition_default_rows()`.execute(db),
    db.selectNoFrom((eb) => eb.lit(1).as('one')).executeTakeFirst(),
    db.transaction().execute(async (trx) => sql`SELECT 1`.execute(trx)),
    db.connection().execute(async (conn) => sql`SELECT 2`.execute(conn)),
  ];
}

it('[ADR-0001 §4.2 #4、#11] 维护句柄正好有 db、close 两个自有属性且冻结；db 是普通 Kysely 实例；创建时不连库、不写日志；close() 以 undefined 完成，之后也不连库', async () => {
  const sockets = watchSocketConnects();
  let seen: unknown;
  try {
    const { logger, lines } = memoryLogger('worker');
    const handle = createMaintDbHandle(configOf('shape'), { logger });
    await turns();
    seen = {
      plain: Object.getPrototypeOf(handle) === Object.prototype,
      frozen: Object.isFrozen(handle),
      keys: Reflect.ownKeys(handle).map(String).sort(),
      close: typeof handle.close,
      db: kyselyView(handle.db),
      connectsAfterCreate: sockets.count(),
      closed: await closeOutcome(handle),
      connectsAfterClose: sockets.count(),
      lines,
    };
  } catch (error) {
    seen = describeError(error);
  } finally {
    sockets.restore();
  }
  expect(seen).toStrictEqual({
    plain: true,
    frozen: true,
    keys: ['close', 'db'],
    close: 'function',
    db: { prototype: true, ownKeys: [] },
    connectsAfterCreate: 0,
    closed: 'resolved undefined',
    connectsAfterClose: 0,
    lines: [],
  });
});

it('[规划/02 §12.6] 维护连接的口令不出现在配置与句柄的 util.inspect（含 showHidden、深层）、JSON、String() 里：只见 redacted 形式', () => {
  const phrase = phraseOf('maint.inspect');
  let seen: unknown;
  try {
    const config = configOf('inspect');
    const { logger } = memoryLogger('worker');
    const handle = createMaintDbHandle(config, { logger });
    const texts = [
      inspect(config, { depth: 10, showHidden: true }),
      inspect({ nested: { config, handle } }, { depth: 10, showHidden: true }),
      inspect(handle, { depth: 10, showHidden: true }),
      JSON.stringify(config),
      JSON.stringify(handle),
      String(config.url),
      `${config.url}`,
    ];
    void handle.close();
    seen = {
      leaks: texts.flatMap((text) => leaksIn(text, [phrase])),
      json: JSON.parse(JSON.stringify(config)) as unknown,
      inspectUrl: inspect(config.url),
    };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toStrictEqual({
    leaks: [],
    json: {
      name: 'dbMaint',
      url: 'postgres://couli_maint:***@127.0.0.1:1/couli',
      max: 1,
      applicationName: 'couli-worker-maint',
      readOnly: false,
    },
    inspectUrl: 'ConnectionUrl(postgres://couli_maint:***@127.0.0.1:1/couli)',
  });
});

it('[ADR-0001 §4.2 #11; 教训 RESUME §8] closeTimeoutMs 只收 1 到 60000 的整数：0、负数、60001、小数、NaN、±Infinity、字符串、null 都同步抛 DbError invalid_option（文案确切）且不连库；1、60000 与省略都可以', async () => {
  const invalid: unknown[] = [
    0,
    -0,
    -1,
    60001,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    '100',
    null,
    2 ** 53,
  ];
  const sockets = watchSocketConnects();
  let seen: unknown;
  try {
    const config = configOf('bounds');
    const { logger, lines } = memoryLogger('worker');
    const outcomes = invalid.map((value) => {
      try {
        const handle = createMaintDbHandle(config, { logger, closeTimeoutMs: value as number });
        void handle.close();
      } catch (error) {
        return dbErrorProblems(error, 'invalid_option');
      }
      return ['returned'];
    });
    const accepted: string[] = [];
    for (const value of [1, 60000, undefined]) {
      try {
        const handle =
          value === undefined
            ? createMaintDbHandle(config, { logger })
            : createMaintDbHandle(config, { logger, closeTimeoutMs: value });
        accepted.push(await closeOutcome(handle));
      } catch (error) {
        accepted.push(describeError(error));
      }
    }
    seen = { outcomes, accepted, lines, connects: sockets.count() };
  } catch (error) {
    seen = describeError(error);
  } finally {
    sockets.restore();
  }
  expect(seen).toStrictEqual({
    outcomes: invalid.map(() => []),
    accepted: ['resolved undefined', 'resolved undefined', 'resolved undefined'],
    lines: [],
    connects: 0,
  });
});

it('[ADR-0001 §4.2 #4、#8; 维护连接契约 3] config 必须正是 loadMaintConnectionConfig 返回的那个对象：拷贝、同字段的仿造对象、worker 主库的池配置、null 都同步抛 DbError invalid_option，不建池、不连库', () => {
  const sockets = watchSocketConnects();
  let seen: unknown;
  try {
    const config = configOf('identity');
    const main = loadConnectionConfig('worker', {
      DATABASE_URL: urlsOf('maint.identity').env.DATABASE_URL,
      REDIS_URL: urlsOf('maint.identity').env.REDIS_URL,
    });
    const { logger, lines } = memoryLogger('worker');
    const candidates: Record<string, unknown> = {
      copy: { ...config },
      frozenCopy: Object.freeze({ ...config }),
      lookAlike: Object.freeze({
        name: 'dbMaint',
        url: main.db.url,
        max: 1,
        applicationName: 'couli-worker-maint',
        readOnly: false,
      }),
      mainPool: main.db,
      inherited: Object.create(config) as unknown,
      nullValue: null,
    };
    const outcomes: Record<string, string[]> = {};
    for (const [label, candidate] of Object.entries(candidates)) {
      try {
        const handle = createMaintDbHandle(candidate as MaintConnectionConfig, { logger });
        void handle.close();
        outcomes[label] = ['returned'];
      } catch (error) {
        outcomes[label] = dbErrorProblems(error, 'invalid_option');
      }
    }
    seen = { outcomes, lines, connects: sockets.count() };
  } catch (error) {
    seen = describeError(error);
  } finally {
    sockets.restore();
  }
  expect(seen).toStrictEqual({
    outcomes: {
      copy: [],
      frozenCopy: [],
      lookAlike: [],
      mainPool: [],
      inherited: [],
      nullValue: [],
    },
    lines: [],
    connects: 0,
  });
});

it('[ADR-0001 §4.2 #11] 从没查询过就 close()：之后每种取连接的方式（原始 SQL、查询、事务、connection()）都以 DbError closed 拒绝、不发起连接；close() 之后同一拍里发出的请求也一样；并发两次与事后第三次 close() 都以 undefined 完成', async () => {
  const sockets = watchSocketConnects();
  let seen: unknown;
  try {
    const { logger, lines } = memoryLogger('worker');
    const handle = createMaintDbHandle(configOf('closed'), { logger });
    const first = handle.close();
    const during = requests(handle.db).map((request) => rejectionProblems(request, 'closed'));
    const second = handle.close();
    const both = await Promise.all([first, second]);
    const after = await Promise.all(
      requests(handle.db).map((request) => rejectionProblems(request, 'closed')),
    );
    const third = await handle.close();
    await turns();
    seen = {
      both,
      third,
      during: await Promise.all(during),
      after,
      connects: sockets.count(),
      lines,
    };
  } catch (error) {
    seen = describeError(error);
  } finally {
    sockets.restore();
  }
  const none = [[], [], [], []];
  expect(seen).toStrictEqual({
    both: [undefined, undefined],
    third: undefined,
    during: none,
    after: none,
    connects: 0,
    lines: [],
  });
});
