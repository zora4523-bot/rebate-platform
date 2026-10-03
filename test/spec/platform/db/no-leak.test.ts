// Rule tests: a database or Redis password never shows in what this module hands out or prints
// (规划/02 §12.6「数据库业务角色的口令」只放 KMS、各进程只读自己的; contract sections 1, 3, 4, 7 and
// 8 of apps/api/src/modules/platform/db/index.ts). Wherever the contract fixes the output, the
// assertion is exact (ConnectionUrl's printed forms, log lines, JSON); `leaksIn` only searches what
// the contract leaves free (the util.inspect layout of whole objects) as a second net.
// Unit tests: no database, no port. Top-level it() only (规划/11 §4.3).
import { format, inspect, types } from 'node:util';
import { expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  ConnectionUrl,
  createDbHandles,
  loadConnectionConfig,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  REDIS_REDACTED,
  describeError,
  envFor,
  leaksIn,
  memoryLogger,
  pgRedactedOf,
  phraseOf,
  urlsOf,
} from './kit.ts';

const DEEP = { showHidden: true, depth: Infinity, breakLength: Infinity } as const;

/** Every printed form of `url` that the contract fixes (section 3), or what went wrong. */
function printedForms(url: unknown): unknown {
  if (!(url instanceof ConnectionUrl)) return `not a ConnectionUrl: ${describeError(url)}`;
  try {
    return {
      ownKeys: Reflect.ownKeys(url).map(String),
      proxy: types.isProxy(url),
      string: String(url),
      template: `${url}`,
      toString: url.toString(),
      toJSON: url.toJSON(),
      json: JSON.stringify(url),
      jsonNested: JSON.stringify({ a: [url] }),
      inspect: inspect(url),
      inspectNested: inspect({ a: { b: { c: url } } }, DEEP),
      format: format('%s|%o|%O|%j', url, url, url, url),
    };
  } catch (error) {
    return describeError(error);
  }
}

function expectedForms(redacted: string): unknown {
  return {
    ownKeys: [],
    proxy: false,
    string: redacted,
    template: redacted,
    toString: redacted,
    toJSON: redacted,
    json: JSON.stringify(redacted),
    jsonNested: `{"a":[${JSON.stringify(redacted)}]}`,
    inspect: `ConnectionUrl(${redacted})`,
    inspectNested: `{ a: { b: { c: ConnectionUrl(${redacted}) } } }`,
    format: `${redacted}|ConnectionUrl(${redacted})|ConnectionUrl(${redacted})|${JSON.stringify(redacted)}`,
  };
}

it('[规划/02 §12.6] ConnectionUrl 的每种打印方式都只给去掉口令的形式：String、模板串、toString、toJSON、JSON（含嵌套）、util.inspect（含嵌套、showHidden）、util.format 确切；实例没有自有属性、不是 Proxy', () => {
  const { env } = urlsOf('printed');
  const queryPhrase = phraseOf('printed.query');
  const inQuery =
    `postgres://couli_readonly@127.0.0.1:1/couli?password=${encodeURIComponent(queryPhrase)}` +
    `&sslpassword=${encodeURIComponent(queryPhrase)}`;
  let urls: unknown[];
  try {
    const config = loadConnectionConfig('admin', envFor('admin', env));
    const queryConfig = loadConnectionConfig('admin', {
      ...envFor('admin', env),
      DATABASE_READ_URL: inQuery,
    });
    urls = [config.db.url, config.dbRead?.url, config.redisUrl, queryConfig.dbRead?.url];
  } catch (error) {
    urls = [describeError(error)];
  }
  expect(urls.map(printedForms)).toStrictEqual([
    expectedForms(pgRedactedOf('couli_app')),
    expectedForms(pgRedactedOf('couli_readonly')),
    expectedForms(REDIS_REDACTED),
    expectedForms('postgres://couli_readonly@127.0.0.1:1/couli'),
  ]);
});

it('[规划/02 §12.6] 整个连接配置对象：JSON 内容确切（URL 只有去掉口令的形式）；util.inspect（showHidden、无限深度）不含任何口令形式', () => {
  const { env, phrases } = urlsOf('whole');
  let seen: unknown;
  try {
    const config = loadConnectionConfig('admin', envFor('admin', env));
    const printed = inspect(config, DEEP);
    seen = {
      json: JSON.parse(JSON.stringify(config)) as unknown,
      inspectLeaks: leaksIn(printed, Object.values(phrases)),
      inspectShowsUrls: [
        printed.includes(`ConnectionUrl(${pgRedactedOf('couli_app')})`),
        printed.includes(`ConnectionUrl(${pgRedactedOf('couli_readonly')})`),
        printed.includes(`ConnectionUrl(${REDIS_REDACTED})`),
      ],
    };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toStrictEqual({
    json: {
      entry: 'admin',
      db: {
        name: 'db',
        url: pgRedactedOf('couli_app'),
        max: 3,
        applicationName: 'couli-admin',
        readOnly: false,
      },
      dbRead: {
        name: 'dbRead',
        url: pgRedactedOf('couli_readonly'),
        max: 5,
        applicationName: 'couli-admin-read',
        readOnly: true,
      },
      redisUrl: REDIS_REDACTED,
    },
    inspectLeaks: [],
    inspectShowsUrls: [true, true, true],
  });
});

it('[规划/02 §12.6] loadConfig 的结果（AppConfig）不再带连接串：设了三个连接变量时，util.inspect、JSON 与 pino 日志行都不含任何口令形式', () => {
  const { env, phrases } = urlsOf('app-config');
  const { logger, lines } = memoryLogger('admin');
  let seen: unknown;
  try {
    const config = loadConfig({ APP_ENV: 'test', ...env });
    logger.warn({ config }, 'config');
    seen = {
      inspect: leaksIn(inspect(config, DEEP), Object.values(phrases)),
      json: leaksIn(JSON.stringify(config), Object.values(phrases)),
      log: leaksIn(lines.join(''), Object.values(phrases)),
      lines: lines.length,
    };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toStrictEqual({ inspect: [], json: [], log: [], lines: 1 });
});

it('[规划/02 §12.6] 缺变量与坏值的 ConfigError：String、util.inspect（showHidden）、JSON、pino 的 err 与 problems 字段都不含任何口令形式', () => {
  const { phrases } = urlsOf('config-error');
  const bad = (phrase: string, scheme: string): string =>
    `${scheme}://couli_app:${encodeURIComponent(phrase)}@/couli`;
  const env = {
    DATABASE_URL: bad(phrases.DATABASE_URL, 'postgres'),
    DATABASE_READ_URL: bad(phrases.DATABASE_READ_URL, 'mysql'),
    REDIS_URL: bad(phrases.REDIS_URL, 'redis'),
  };
  const { logger, lines } = memoryLogger('admin');
  let error: unknown = 'returned';
  try {
    loadConnectionConfig('admin', env);
  } catch (caught) {
    error = caught;
  }
  const isConfigError = error instanceof ConfigError;
  logger.error({ err: error }, 'as_err');
  if (error instanceof ConfigError) logger.fatal({ problems: error.problems }, 'config_invalid');
  const all = Object.values(phrases);
  expect({
    isConfigError,
    string: leaksIn(String(error), all),
    inspect: leaksIn(inspect(error, DEEP), all),
    json: leaksIn(JSON.stringify(error) ?? '', all),
    log: leaksIn(lines.join(''), all),
    lines: lines.length,
  }).toStrictEqual({ isConfigError: true, string: [], inspect: [], json: [], log: [], lines: 2 });
});

it('[规划/02 §12.6] 句柄对象不外露连接池与连接串：JSON 内容确切，util.inspect（showHidden、无限深度）不含任何口令形式，关闭后也一样', async () => {
  const { env, phrases } = urlsOf('handles');
  const { logger } = memoryLogger('admin');
  let seen: unknown;
  try {
    const handles = createDbHandles(loadConnectionConfig('admin', envFor('admin', env)), {
      logger,
    });
    const before = {
      json: JSON.parse(JSON.stringify(handles)) as unknown,
      inspect: leaksIn(inspect(handles, DEEP), Object.values(phrases)),
      db: leaksIn(inspect(handles.db, DEEP), Object.values(phrases)),
    };
    await handles.close();
    seen = {
      before,
      after: {
        json: JSON.parse(JSON.stringify(handles)) as unknown,
        inspect: leaksIn(inspect(handles, DEEP), Object.values(phrases)),
      },
    };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toStrictEqual({
    before: { json: { db: {}, dbRead: {} }, inspect: [], db: [] },
    after: { json: { db: {}, dbRead: {} }, inspect: [] },
  });
});
