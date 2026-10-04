// Rule tests for loadMaintConnectionConfig (task B1-01n; contract sections 1 and 2 of
// apps/api/src/modules/platform/db/maint.ts, which applies addenda 1–3 of the db contract to
// DATABASE_MAINT_URL). Basis: ADR-0001 §4.2 第 4 项 (worker 定时任务以 couli_maint 建和删分区), 第 8 项
// (couli_maint 角色), 第 11 项 (每进程连接池); 规划/02 §15.1 PG 一行 (由 worker 定时任务以专用角色执行);
// 规划/02 §12.6 (口令不回显). Expected values are written out by hand. Unit tests: no database, no
// port. Top-level it() only (规划/11 §4.3).
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConnectionConfig } from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  MAINT_APPLICATION_NAME,
  MAINT_POOL_SIZE,
} from '../../../../apps/api/src/modules/platform/db/maint.ts';
import { describeError, phraseOf, urlsOf } from './kit.ts';
import {
  APP_ENVS,
  MAINT_PROBLEMS,
  MAINT_VAR,
  expectedMaint,
  loadView,
  maintProblems,
  maintRedactedOf,
  maintUrlOf,
} from './maint-kit.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

const READABLE = encodeURIComponent(fileURLToPath(import.meta.url));
const MISSING = encodeURIComponent(
  fileURLToPath(new URL('./no-such-maint-ca.pem', import.meta.url)),
);
const OTHER_ENTRIES = ['api', 'stream', 'admin', 'payout'] as const;

it('[ADR-0001 §4.2 #4、#8、#11; 规划/02 §15.1] worker 在 APP_ENV 为 local、staging、prod 时缺 DATABASE_MAINT_URL（未设或空串）就拒绝启动：ConfigError 只列「DATABASE_MAINT_URL: must be set for the worker entry」一条；APP_ENV 未设、空串或不认识（TEST、 test、dev）时同样拒绝', () => {
  const appEnvs = ['local', 'staging', 'prod', '', 'TEST', ' test', 'dev', undefined];
  const got = appEnvs.map((appEnv) => ({
    appEnv: String(appEnv),
    unset: maintProblems(undefined, appEnv, MAINT_PROBLEMS.missing),
    empty: maintProblems('', appEnv, MAINT_PROBLEMS.missing),
  }));
  expect(got).toStrictEqual(
    appEnvs.map((appEnv) => ({ appEnv: String(appEnv), unset: [], empty: [] })),
  );
});

it('[ADR-0001 §4.2 #4; 待编排会话确认] APP_ENV=test 时 worker 可以不设 DATABASE_MAINT_URL（未设或空串）：返回 null（不建维护连接池）', () => {
  expect({
    unset: loadView('worker', { APP_ENV: 'test' }),
    empty: loadView('worker', { APP_ENV: 'test', [MAINT_VAR]: '' }),
    withOthers: loadView('worker', { APP_ENV: 'test', ...urlsOf('maint.test.null').env }),
  }).toStrictEqual({ unset: null, empty: null, withOthers: null });
});

it('[ADR-0001 §4.2 #4、#8、#11] worker 在四种 APP_ENV 下设了合法的 couli_maint 连接串：得到确切的维护池配置——name dbMaint、池大小 1、会话名 couli-worker-maint、可写，冻结的普通对象；url 的 redacted 不含口令、reveal() 是 WHATWG 序列化；常量 MAINT_POOL_SIZE 为 1、MAINT_APPLICATION_NAME 为 couli-worker-maint', () => {
  const value = maintUrlOf('valid');
  expect({
    constants: [MAINT_POOL_SIZE, MAINT_APPLICATION_NAME],
    views: APP_ENVS.map((appEnv) => loadView('worker', { APP_ENV: appEnv, [MAINT_VAR]: value })),
  }).toStrictEqual({
    constants: [1, 'couli-worker-maint'],
    views: APP_ENVS.map(() => expectedMaint(value, maintRedactedOf())),
  });
});

it('[ADR-0001 §4.2 #11; ADR-0002 §5; 规划/02 §12.6] 合法写法都收：postgresql://、首尾空白、大写协议、端口与库名不同、sslmode=verify-full 带可读的 sslrootcert、口令放在 password 查询参数、用户名用百分号编码（couli%5Fmaint 解码后是 couli_maint）；redacted 去掉口令与查询串', () => {
  const pw = encodeURIComponent(phraseOf('maint.accepted'));
  const cases: readonly (readonly [string, string, string])[] = [
    [
      `postgresql://couli_maint:${pw}@db.internal:5433/couli?sslmode=require`,
      `postgresql://couli_maint:${pw}@db.internal:5433/couli?sslmode=require`,
      'postgresql://couli_maint:***@db.internal:5433/couli',
    ],
    [
      `  postgres://couli_maint:${pw}@127.0.0.1:5433/couli  `,
      `postgres://couli_maint:${pw}@127.0.0.1:5433/couli`,
      'postgres://couli_maint:***@127.0.0.1:5433/couli',
    ],
    [
      `POSTGRES://couli_maint:${pw}@127.0.0.1:5433/couli_x`,
      `postgres://couli_maint:${pw}@127.0.0.1:5433/couli_x`,
      'postgres://couli_maint:***@127.0.0.1:5433/couli_x',
    ],
    [
      `postgres://couli_maint:${pw}@10.0.0.10:5433/couli?sslmode=verify-full&sslrootcert=${READABLE}`,
      `postgres://couli_maint:${pw}@10.0.0.10:5433/couli?sslmode=verify-full&sslrootcert=${READABLE}`,
      'postgres://couli_maint:***@10.0.0.10:5433/couli',
    ],
    [
      `postgres://couli_maint@127.0.0.1:5433/couli?password=${pw}&options=-c%20statement_timeout%3D60000`,
      `postgres://couli_maint@127.0.0.1:5433/couli?password=${pw}&options=-c%20statement_timeout%3D60000`,
      'postgres://couli_maint@127.0.0.1:5433/couli',
    ],
    [
      `postgres://couli%5Fmaint:${pw}@127.0.0.1:5433/couli`,
      `postgres://couli%5Fmaint:${pw}@127.0.0.1:5433/couli`,
      'postgres://couli%5Fmaint:***@127.0.0.1:5433/couli',
    ],
  ];
  expect(
    cases.map(([value]) => loadView('worker', { APP_ENV: 'prod', [MAINT_VAR]: value })),
  ).toStrictEqual(cases.map(([, reveal, redacted]) => expectedMaint(reveal, redacted)));
});

/** Malformed postgres URLs, each carrying the password `phrase` where the URL has room for one. */
function malformedMaint(phrase: string): string[] {
  const pw = encodeURIComponent(phrase);
  return [
    `mysql://couli_maint:${pw}@127.0.0.1:1/couli`,
    `http://couli_maint:${pw}@127.0.0.1:1/couli`,
    `redis://couli_maint:${pw}@127.0.0.1:1/couli`,
    `postgres://:${pw}@127.0.0.1:1/couli`,
    'postgres://127.0.0.1:1/couli',
    `postgres://couli_maint:${pw}@127.0.0.1:1`,
    `postgres://couli_maint:${pw}@127.0.0.1:1/`,
    'postgres:///couli',
    `postgres://couli_maint:${pw}@/couli`,
    `postgres://couli_maint:${pw}@127.0.0.1:99999/couli`,
    `couli_maint:${pw}@127.0.0.1:1/couli`,
    `postgres://couli_maint:p%word${pw}@127.0.0.1:1/couli`,
    `postgres://couli%zzmaint:${pw}@127.0.0.1:1/couli`,
    `postgres://couli_maint:${pw}@127.0.0.1:1/cou%li`,
    pw,
    ' ',
    'not a url',
  ];
}

it('[ADR-0001 §4.2 #11; 规划/02 §12.6] DATABASE_MAINT_URL 格式不对（含无效的百分号转义）：local、test、staging、prod 下都只报这一条固定文案，不回显值的任何部分（含口令）——APP_ENV=test 时设了坏值也拒绝', () => {
  const values = malformedMaint(phraseOf('maint.malformed'));
  const got = APP_ENVS.map((appEnv) =>
    values.map((value) => maintProblems(value, appEnv, MAINT_PROBLEMS.malformed)),
  );
  expect(got).toStrictEqual(APP_ENVS.map(() => values.map(() => [])));
});

it('[ADR-0001 §4.2 #3、#11; 路径 B 契约补充 1、2] DATABASE_MAINT_URL 的查询参数同样只收白名单：binary、types、client_encoding、application_name、user、host、port、dbname、ssl、statement_timeout、编码的名字、无等号、重复、sslmode=prefer、sslrootcert 配 require 或缺 sslrootcert 的 verify-ca 都只报查询参数这一条', () => {
  const queries = [
    'binary=false',
    'binary=true',
    'binary',
    'types=x',
    'client_encoding=SQL_ASCII',
    'application_name=other',
    'user=couli_app',
    'host=10.0.0.9',
    'port=5434',
    'dbname=postgres',
    'ssl=true',
    'statement_timeout=1',
    'SSLMODE=require',
    'ssl%6dode=verify-full',
    'opti%6Fns=-c%20x%3Dy',
    '=x',
    'sslmode=require&sslmode=disable',
    'sslmode=prefer',
    'sslmode=allow',
    `sslmode=require&sslrootcert=${READABLE}`,
    'sslmode=verify-ca',
    `sslrootcert=${READABLE}`,
  ];
  expect(
    queries.map((query) =>
      maintProblems(maintUrlOf('query', 'couli_maint', query), 'staging', MAINT_PROBLEMS.query),
    ),
  ).toStrictEqual(queries.map(() => []));
});

it('[ADR-0001 §4.2 #11; 路径 B 契约补充 3] DATABASE_MAINT_URL 解码后的用户名、库名、口令（userinfo 与查询参数 password）、options 含控制字符（%00、%0A、%1F、%7F）只报控制字符这一条', () => {
  const pw = encodeURIComponent(phraseOf('maint.control'));
  const urlOf = (user: string, password: string, database: string, query: string): string =>
    `postgres://${user}:${password}@127.0.0.1:1/${database}${query === '' ? '' : `?${query}`}`;
  const values = [
    urlOf('couli_maint', pw, 'couli', 'options=-c%20x%3Dy%00application_name%00z'),
    urlOf('couli_maint', pw, 'couli', 'options=%0A'),
    urlOf('couli_maint', pw, 'couli%7F', ''),
    urlOf('couli_maint', `${pw}%1F`, 'couli', ''),
    urlOf('couli_maint', 'not-this-one', 'couli', `password=${pw}%00`),
    urlOf('couli_maint%00', pw, 'couli', ''),
  ];
  expect(values.map((value) => maintProblems(value, 'prod', MAINT_PROBLEMS.control))).toStrictEqual(
    values.map(() => []),
  );
});

it('[ADR-0001 §4.2 #4、#8; 待编排会话确认] DATABASE_MAINT_URL 的用户名（解码后）必须正好是 couli_maint：couli_app、couli_payout、couli_readonly、couli_migrator、postgres、大小写不同、前后多字符、带空格都只报「must connect as couli_maint」一条；APP_ENV=test 也一样', () => {
  const roles = [
    'couli_app',
    'couli_payout',
    'couli_readonly',
    'couli_migrator',
    'postgres',
    'COULI_MAINT',
    'Couli_maint',
    'couli_maint2',
    'xcouli_maint',
    'couli_maint%20',
    '%20couli_maint',
    'couli-maint',
  ];
  const got = ['prod', 'test'].map((appEnv) =>
    roles.map((role) => maintProblems(maintUrlOf('role', role), appEnv, MAINT_PROBLEMS.role)),
  );
  expect(got).toStrictEqual([roles.map(() => []), roles.map(() => [])]);
});

it('[ADR-0002 §5; 路径 B 契约补充 2、3] 一个变量只报一条、先到先报：格式错误 → 查询参数 → 控制字符 → 角色 → 读不到的 sslrootcert；couli_maint 配读不到的 sslrootcert 只报 sslrootcert 那条（不带路径）', () => {
  const pw = encodeURIComponent(phraseOf('maint.order'));
  const urlOf = (user: string, password: string, query: string): string =>
    `postgres://${user}:${password}@127.0.0.1:1/couli${query === '' ? '' : `?${query}`}`;
  const rootQuery = `sslmode=verify-full&sslrootcert=${MISSING}`;
  expect({
    malformedFirst: maintProblems(
      urlOf('couli_app', 'p%word', `binary=true&options=%00&${rootQuery}`),
      'prod',
      MAINT_PROBLEMS.malformed,
    ),
    queryBeforeControl: maintProblems(
      urlOf('couli_app%00', pw, 'binary=true&options=%00'),
      'prod',
      MAINT_PROBLEMS.query,
    ),
    controlBeforeRole: maintProblems(
      urlOf('couli_app', pw, `options=%00&${rootQuery}`),
      'prod',
      MAINT_PROBLEMS.control,
    ),
    roleBeforeRoot: maintProblems(urlOf('couli_app', pw, rootQuery), 'prod', MAINT_PROBLEMS.role),
    root: maintProblems(urlOf('couli_maint', pw, rootQuery), 'prod', MAINT_PROBLEMS.root),
    rootVerifyCa: maintProblems(
      urlOf('couli_maint', pw, `sslmode=verify-ca&sslrootcert=${MISSING}`),
      'test',
      MAINT_PROBLEMS.root,
    ),
  }).toStrictEqual({
    malformedFirst: [],
    queryBeforeControl: [],
    controlBeforeRole: [],
    roleBeforeRoot: [],
    root: [],
    rootVerifyCa: [],
  });
});

it('[规划/02 §3.1; ADR-0001 §4.2 #20] api、stream、admin、payout 不读 DATABASE_MAINT_URL：无论 APP_ENV 与值（合法、坏值、别的角色、空）都返回 null，且一个 env 属性都不读', () => {
  const values = [
    maintUrlOf('other'),
    'not a url',
    maintUrlOf('other', 'couli_app'),
    '',
    undefined,
  ];
  const got: unknown[] = [];
  for (const entry of OTHER_ENTRIES) {
    for (const appEnv of [...APP_ENVS, undefined]) {
      for (const value of values) {
        const read: string[] = [];
        const target: Record<string, string> = {};
        if (appEnv !== undefined) target.APP_ENV = appEnv;
        if (value !== undefined) target[MAINT_VAR] = value;
        const env = new Proxy(target, {
          get(object, key) {
            read.push(String(key));
            return Reflect.get(object, key) as unknown;
          },
          has(object, key) {
            read.push(`has ${String(key)}`);
            return Reflect.has(object, key);
          },
          ownKeys(object) {
            read.push('ownKeys');
            return Reflect.ownKeys(object);
          },
          getOwnPropertyDescriptor(object, key) {
            read.push(`descriptor ${String(key)}`);
            return Reflect.getOwnPropertyDescriptor(object, key);
          },
        });
        got.push({ entry, view: loadView(entry, env), read });
      }
    }
  }
  const expected: unknown[] = [];
  for (const entry of OTHER_ENTRIES) {
    for (let i = 0; i < (APP_ENVS.length + 1) * values.length; i += 1) {
      expected.push({ entry, view: null, read: [] });
    }
  }
  expect(got).toStrictEqual(expected);
});

it('[apps/api AGENTS 硬规则 6; 规划/02 §12.6] worker 只读 env 里的 APP_ENV 与 DATABASE_MAINT_URL 两个名字：不读 process.env、不改传入的对象（冻结的对象也能用），其他变量（DATABASE_URL、MIGRATOR_DATABASE_URL 等）不影响结果', () => {
  vi.stubEnv(MAINT_VAR, maintUrlOf('process'));
  vi.stubEnv('APP_ENV', 'test');
  const value = maintUrlOf('pure');
  const target = Object.freeze({
    APP_ENV: 'prod',
    [MAINT_VAR]: value,
    DATABASE_URL: urlsOf('maint.pure').env.DATABASE_URL,
    MIGRATOR_DATABASE_URL: 'not a url',
    database_maint_url: 'not a url',
    DATABASE_MAINT_URL_RO: 'not a url',
  });
  const before = JSON.stringify(target);
  const read = new Set<string>();
  const env = new Proxy(target, {
    get(object, key) {
      read.add(String(key));
      return Reflect.get(object, key) as unknown;
    },
    ownKeys(object) {
      read.add('(ownKeys)');
      return Reflect.ownKeys(object);
    },
  });
  expect({
    view: loadView('worker', env),
    readOnlyThese: [...read].filter((key) => key !== 'APP_ENV' && key !== MAINT_VAR),
    unchanged: JSON.stringify(target) === before,
    fromProcessOnly: maintProblems(undefined, 'prod', MAINT_PROBLEMS.missing),
  }).toStrictEqual({
    view: expectedMaint(value, maintRedactedOf()),
    readOnlyThese: [],
    unchanged: true,
    fromProcessOnly: [],
  });
});

it('[ADR-0001 §4.2 #11 每进程池大小（反例，现状即满足）] loadConnectionConfig 不因 DATABASE_MAINT_URL 改变：worker 的连接配置仍只有 entry、db、dbRead、redisUrl，db 仍是 couli_app、池 10', () => {
  const { env } = urlsOf('maint.unchanged');
  let seen: unknown;
  try {
    const config = loadConnectionConfig('worker', {
      DATABASE_URL: env.DATABASE_URL,
      REDIS_URL: env.REDIS_URL,
      [MAINT_VAR]: maintUrlOf('unchanged'),
      APP_ENV: 'prod',
    });
    seen = {
      keys: Reflect.ownKeys(config).map(String).sort(),
      max: config.db.max,
      applicationName: config.db.applicationName,
      reveal: config.db.url.reveal(),
    };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toStrictEqual({
    keys: ['db', 'dbRead', 'entry', 'redisUrl'],
    max: 10,
    applicationName: 'couli-worker',
    reveal: env.DATABASE_URL,
  });
});
