// Contract addendum (code review round 3, path B) — query parameters of the database URLs.
// Decided by the orchestration session on 2026-10-04 (couli-runs/B1-01f/decision-orchestrator.md);
// it adds to section 1 of the contract in apps/api/src/modules/platform/db/index.ts, whose header
// is not edited any more. Basis: ADR-0001 §4.2 第 3 项 (int8 统一解析为 BigInt) and 第 11 项;
// AGENTS.md §4 第 1 条 (金额是整数分). Found by the code review: pg reads every query parameter
// of a connection string into its client configuration, and `binary=false` (a non-empty string,
// hence true) switches results to the binary format, which bypasses the text int8 → BigInt
// parsers: 9007199254740993 came back as 9007199254740992 and −1 as 17275735533028241000.
//
//   Amended by addendum 2 (connection-tls.test.ts, code review round 4): names are compared in
//   their literal form (no percent-encoding), `prefer` is refused, sslrootcert goes only with
//   verify-ca (required) or verify-full (optional) and must be readable; the message below is
//   the amended one.
//   - DATABASE_URL (every entry) and DATABASE_READ_URL (admin) may carry only these query
//     parameters, each at most once, names compared exactly in their literal form:
//       sslmode      one of disable, require, verify-ca, verify-full
//       sslrootcert  path of the CA certificate (ADR-0002 §5 强制 SSL), see addendum 2
//       options      any value (startup options; the read-only merge of dbRead stays as it is:
//                    `-c default_transaction_read_only=on` appended, a final odd backslash
//                    removed first)
//       password     any value; sslpassword any value — accepted only because the existing rule
//                    tests (connection-config, no-leak) use them; pg ignores sslpassword
//     Anything else is refused: binary, types, client_encoding, replication, application_name
//     (the contract fixes every session's name), host, hostaddr, port, user, dbname, ssl,
//     sslcert, sslkey, sslnegotiation, uselibpqcompat, statement_timeout, any unknown or
//     differently cased name, a parameter without `=`, an empty name, a repeated parameter and
//     an sslmode value not in the list.
//   - A refused URL is one problem of `loadConnectionConfig`, in the usual order, exactly:
//       `<NAME>: query parameters may only be sslmode (disable, require, verify-ca or verify-full), sslrootcert (required by verify-ca, allowed with verify-full), options, password or sslpassword, each at most once and with a literal name`
//     A URL that is malformed (section 1) reports the malformed problem only. The message never
//     contains any part of the value; ConfigError as in section 1 (no cause).
//   - The fragment is not a query parameter and stays ignored. REDIS_URL is not affected.
//   - The implementation gives pg only the known connection fields (host, port, user, password,
//     database, ssl, options, application_name, keepalive, types) — it never spreads a whole
//     parsed configuration into the pool configuration.
// Unit tests: no database, no port. Top-level it() only (规划/11 §4.3).
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  ConnectionUrl,
  loadConnectionConfig,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  ENTRIES,
  configErrorOf,
  configErrorProblems,
  describeError,
  envFor,
  malformed,
  phraseOf,
  urlsOf,
  type Entry,
  type VarName,
} from './kit.ts';

/** A readable file standing in for a CA certificate (only its contents are read here). */
const READABLE = fileURLToPath(import.meta.url);

const QUERY_MESSAGE =
  'query parameters may only be sslmode (disable, require, verify-ca or verify-full), sslrootcert (required by verify-ca, allowed with verify-full), options, password or sslpassword, each at most once and with a literal name';

function refused(name: VarName): string {
  return `${name}: ${QUERY_MESSAGE}`;
}

/** Query strings (without `?`) that must be refused; `pw` is a password-like value. */
function refusedQueries(pw: string): string[] {
  return [
    'binary=false',
    'binary=true',
    'binary=0',
    'binary',
    'options',
    'sslrootcert',
    `sslmode=require&password`,
    'types=x',
    'client_encoding=SQL_ASCII',
    'replication=database',
    'replication=true',
    'application_name=other',
    `host=${pw}`,
    'hostaddr=10.0.0.9',
    'port=1',
    'user=couli_migrator',
    'dbname=postgres',
    'ssl=false',
    'sslcert=/tmp/client.crt',
    `sslkey=/tmp/${pw}.key`,
    'sslnegotiation=direct',
    'uselibpqcompat=true',
    'statement_timeout=1',
    `unknown_param=${pw}`,
    'Binary=false',
    'SSLMODE=require',
    '%62inary=false',
    'binary%3Dfalse',
    '=x',
    'sslmode=allow',
    'sslmode=prefer',
    'ssl%6dode=verify-full',
    'opti%6Fns=-c%20search_path%3Dapp',
    `sslrootcert=${encodeURIComponent(READABLE)}`,
    `sslmode=require&sslrootcert=${encodeURIComponent(READABLE)}`,
    'sslmode=verify-ca',
    'sslmode=no-verify',
    'sslmode=',
    'sslmode=REQUIRE',
    'sslmode=require&sslmode=disable',
    'options=-c%20a%3D1&options=-c%20b%3D2',
    `password=${pw}&password=${pw}`,
    'sslmode=require&binary=false',
    `options=-c%20statement_timeout%3D5000&types=${pw}`,
  ];
}

/** Query strings that must be accepted, and kept as given (reveal()). */
function acceptedQueries(pw: string): string[] {
  return [
    '',
    'sslmode=disable',
    'sslmode=require',
    'sslmode=verify-full',
    `sslmode=verify-ca&sslrootcert=${encodeURIComponent(READABLE)}`,
    'options=-c%20statement_timeout%3D5000',
    `password=${pw}`,
    `sslpassword=${pw}`,
    `sslmode=verify-full&sslrootcert=${encodeURIComponent(READABLE)}&options=-c%20search_path%3Dapp&password=${pw}&sslpassword=${pw}`,
  ];
}

function withQuery(url: string, query: string): string {
  return query === '' ? url : `${url}?${query}`;
}

/** Problems found for `run` against exactly `problems` (an empty list means exactly that error). */
function problemsOrWhat(run: () => unknown, problems: readonly string[]): string[] {
  const error = configErrorOf(run);
  return typeof error === 'string' ? [error] : configErrorProblems(error, problems);
}

function revealOf(run: () => ConnectionUrl | null | undefined): string {
  try {
    const url = run();
    return url instanceof ConnectionUrl ? url.reveal() : `not a ConnectionUrl: ${String(url)}`;
  } catch (error) {
    return describeError(error);
  }
}

const CASES: readonly (readonly [VarName, Entry])[] = [
  ...ENTRIES.map((entry) => ['DATABASE_URL', entry] as const),
  ['DATABASE_READ_URL', 'admin'],
];

for (const [name, entry] of CASES) {
  it(`[ADR-0001 §4.2 #3, #11; 路径 B 契约补充] ${entry} 的 ${name} 查询参数只认白名单：binary（含 false）、types、client_encoding、replication、application_name、改连接目标的参数、未知名、大小写不同、编码过的名、无值、重复、不在列表里的 sslmode（含 prefer）、不配 verify-ca / verify-full 的 sslrootcert 都拒绝，只报这一条固定文案；白名单内的写法照收并原样保留`, () => {
    const { env } = urlsOf(`params.${entry}.${name}`);
    const pw = encodeURIComponent(phraseOf(`params.${entry}.${name}.value`));
    const base = env[name];
    const refusedOutcomes = refusedQueries(pw).map((query) =>
      problemsOrWhat(
        () =>
          loadConnectionConfig(entry, { ...envFor(entry, env), [name]: withQuery(base, query) }),
        [refused(name)],
      ),
    );
    const accepted = acceptedQueries(pw).map((query) =>
      revealOf(() => {
        const config = loadConnectionConfig(entry, {
          ...envFor(entry, env),
          [name]: withQuery(base, query),
        });
        return name === 'DATABASE_URL' ? config.db.url : config.dbRead?.url;
      }),
    );
    expect({ refusedOutcomes, accepted }).toStrictEqual({
      refusedOutcomes: refusedQueries(pw).map(() => []),
      accepted: acceptedQueries(pw).map((query) => withQuery(base, query)),
    });
  });
}

it('[ADR-0001 §4.2 #11; 路径 B 契约补充] 查询参数问题与其他问题一起按顺序报：admin 两个库都带 binary=false 且 Redis 坏，三条；URL 本身坏的只报格式那一条；片段不算查询参数；REDIS_URL 的查询串不受这条约束', () => {
  const { env } = urlsOf('params.together');
  const badRedis = 'http://127.0.0.1:1/0';
  const malformedWithBinary = `mysql://couli_app:x@127.0.0.1:1/couli?binary=false`;
  expect({
    admin: problemsOrWhat(
      () =>
        loadConnectionConfig('admin', {
          DATABASE_URL: `${env.DATABASE_URL}?binary=false`,
          DATABASE_READ_URL: `${env.DATABASE_READ_URL}?types=x`,
          REDIS_URL: badRedis,
        }),
      [refused('DATABASE_URL'), refused('DATABASE_READ_URL'), malformed('REDIS_URL')],
    ),
    malformedFirst: problemsOrWhat(
      () => loadConnectionConfig('payout', { DATABASE_URL: malformedWithBinary }),
      [malformed('DATABASE_URL')],
    ),
    fragment: revealOf(
      () =>
        loadConnectionConfig('payout', { DATABASE_URL: `${env.DATABASE_URL}#binary=false` }).db.url,
    ),
    redis: revealOf(
      () =>
        loadConnectionConfig('worker', {
          DATABASE_URL: env.DATABASE_URL,
          REDIS_URL: `${env.REDIS_URL}?db=3&family=6`,
        }).redisUrl,
    ),
    ignoredReadUrl: revealOf(
      () =>
        loadConnectionConfig('api', {
          ...envFor('api', env),
          DATABASE_READ_URL: `${env.DATABASE_READ_URL}?binary=false`,
        }).db.url,
    ),
  }).toStrictEqual({
    admin: [],
    malformedFirst: [],
    fragment: `${env.DATABASE_URL}#binary=false`,
    redis: `${env.REDIS_URL}?db=3&family=6`,
    ignoredReadUrl: env.DATABASE_URL,
  });
});
