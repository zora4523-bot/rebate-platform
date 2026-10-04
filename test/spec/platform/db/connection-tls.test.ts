// Contract addendum 2 (code review round 4, path B) — discrete connection fields, literal
// parameter names, explicit TLS. Decided by the orchestration session on 2026-10-04
// (couli-runs/B1-01f/decision-orchestrator.md, last section). It amends addendum 1
// (connection-params.test.ts) and section 4 of apps/api/src/modules/platform/db/index.ts.
// Basis: ADR-0002 §5 (登录强制 SSL 和口令认证); 规划/02 §12.6 (数据库业务角色的口令); ADR-0001
// §4.2 第 3、11 项. Found by the code review: with a literal `%` in the password, pg's own
// connection-string parser re-encodes the whole string, so a parameter name that was accepted
// after decoding (`ssl%6dode=verify-full`) no longer means sslmode to pg: the pool ran with
// ssl=false and a hijacked endpoint could ask for the password in clear text.
//
// 1. Discrete fields. The implementation parses DATABASE_URL and DATABASE_READ_URL itself and
//    gives pg only discrete fields: host (hostname as written; IPv6 literals are out of scope —
//    ADR-0002 §5 uses an internal address), port (number, 5432
//    when absent), user and database (percent-decoded), password (the `password` query
//    parameter when present, as pg does, else the percent-decoded user-info password), ssl (the
//    object below), options (decoded; the dbRead merge of addendum 1 unchanged),
//    application_name, keepAlive, types. It never gives pg a connection string, and never a
//    parse result of pg or pg-connection-string.
// 2. Percent-encoding. A user, password or database name with an invalid escape (a `%` not
//    followed by two hex digits, e.g. a literal `p%word`) makes the URL malformed (section 1
//    message). Characters such as % @ : # / must be written percent-encoded (%25 %40 %3A %23
//    %2F); they reach the server decoded.
// 3. Literal names. A query parameter name is the text before the first `=` of each `&` part,
//    compared as written: any `%` or `+` in a name is refused (`ssl%6dode`, `opti%6Fns`).
//    Values are decoded as application/x-www-form-urlencoded (URLSearchParams).
// 4. TLS, built explicitly, never weaker than the URL declares:
//      no sslmode   ssl: false (plain connection; staging and prod URLs must say verify-full —
//                   enforcing that per APP_ENV is a follow-up, not this task)
//      disable      ssl: false
//      prefer       refused (it may fall back to plain text without telling anyone)
//      require      ssl: { rejectUnauthorized: false } — encrypted, server not verified
//      verify-ca    ssl: { rejectUnauthorized: true, ca: <sslrootcert>, checkServerIdentity:
//                   a function returning undefined } — sslrootcert required
//      verify-full  ssl: { rejectUnauthorized: true } plus ca: <sslrootcert> when given
//    sslrootcert is allowed only with verify-ca or verify-full; its file is read as UTF-8 by
//    loadConnectionConfig (at start-up). A file that cannot be read is one problem, exactly:
//      `<NAME>: sslrootcert could not be read`
//    (never the path, never the error). The TLS settings stay private: ConnectionConfig keeps
//    its exact shape (section 1). Seen from the wire: no sslmode / disable starts with a plain
//    StartupMessage; require / verify-ca / verify-full start with an SSLRequest, hand exactly the
//    options above to tls.connect, and a server that answers 'N' fails the query with pg's
//    "The server does not support SSL connections" — no fallback to plain text.
// 5. The query-parameter message of addendum 1 becomes:
//      `<NAME>: query parameters may only be sslmode (disable, require, verify-ca or verify-full), sslrootcert (required by verify-ca, allowed with verify-full), options, password or sslpassword, each at most once and with a literal name`
//    A malformed URL reports the malformed problem only; otherwise a query problem comes
//    before an unreadable sslrootcert (one problem per variable).
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

const QUERY_MESSAGE =
  'query parameters may only be sslmode (disable, require, verify-ca or verify-full), sslrootcert (required by verify-ca, allowed with verify-full), options, password or sslpassword, each at most once and with a literal name';
const ROOT_MESSAGE = 'sslrootcert could not be read';

const READABLE = encodeURIComponent(fileURLToPath(import.meta.url));
const MISSING = encodeURIComponent(
  fileURLToPath(new URL('./no-such-ca-file.pem', import.meta.url)),
);
const DIRECTORY = encodeURIComponent(fileURLToPath(new URL('.', import.meta.url)));

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

/** A postgres URL of `role` whose user-info password is written exactly as `rawPassword`. */
function urlWith(role: string, rawPassword: string, query: string): string {
  return `postgres://${role}:${rawPassword}@127.0.0.1:1/couli${query === '' ? '' : `?${query}`}`;
}

const CASES: readonly (readonly [VarName, Entry])[] = [
  ...ENTRIES.map((entry) => ['DATABASE_URL', entry] as const),
  ['DATABASE_READ_URL', 'admin'],
];

for (const [name, entry] of CASES) {
  it(`[ADR-0002 §5; 路径 B 契约补充 2] ${entry} 的 ${name}：编码过的参数名（ssl%6dode、opti%6Fns、加号）、prefer、不配 verify-ca / verify-full 的 sslrootcert、缺 sslrootcert 的 verify-ca 都按查询参数问题拒绝；读不到的 sslrootcert 报确切的一条且不带路径；口令、用户名、库名里有非法百分号转义（字面量 %）时报格式错误——评审复现的那条 URL 也在内；口令里正确编码的 % @ : # /、不带 sslmode、disable、require、verify-ca 加可读的 sslrootcert、verify-full 都照收且原样保留`, () => {
    const { env } = urlsOf(`tls.${entry}.${name}`);
    const role =
      name === 'DATABASE_URL'
        ? entry === 'payout'
          ? 'couli_payout'
          : 'couli_app'
        : 'couli_readonly';
    const pw = encodeURIComponent(phraseOf(`tls.${entry}.${name}.pw`));
    const queryRefused = [
      'ssl%6dode=verify-full',
      'ssl%6Dode=verify-full',
      `ssl%6dode=verify-full&sslrootcert=${READABLE}`,
      'opti%6Fns=-c%20statement_timeout%3D1',
      'ssl+mode=require',
      'sslmode%3Drequire',
      'sslmode=prefer',
      `sslmode=prefer&sslrootcert=${READABLE}`,
      `sslrootcert=${READABLE}`,
      `sslmode=disable&sslrootcert=${READABLE}`,
      `sslmode=require&sslrootcert=${READABLE}`,
      `sslmode=require&sslrootcert=${MISSING}`,
      `sslmode=disable&sslrootcert=${MISSING}`,
      'sslmode=verify-ca',
      `sslmode=verify-ca&ssl%72ootcert=${READABLE}`,
      `sslmode=verify-ca&sslrootcert=${MISSING}&binary=false`,
    ].map((query) => urlWith(role, pw, query));
    const rootUnreadable = [
      `sslmode=verify-ca&sslrootcert=${MISSING}`,
      `sslmode=verify-full&sslrootcert=${MISSING}`,
      `sslmode=verify-full&sslrootcert=${DIRECTORY}`,
      'sslmode=verify-full&sslrootcert=',
    ].map((query) => urlWith(role, pw, query));
    const badEscape = [
      urlWith(role, 'p%word', 'ssl%6dode=verify-full'),
      urlWith(role, 'p%word', 'sslmode=verify-full'),
      urlWith(role, `${pw}%`, 'sslmode=require'),
      urlWith(role, `${pw}%4`, ''),
      urlWith(role, `${pw}%zz`, 'sslmode=disable'),
      `postgres://couli%app:${pw}@127.0.0.1:1/couli?sslmode=verify-full`,
      `postgres://${role}:${pw}@127.0.0.1:1/cou%li?sslmode=verify-full`,
    ];
    const check = (value: string, problem: string): string[] =>
      problemsOrWhat(
        () => loadConnectionConfig(entry, { ...envFor(entry, env), [name]: value }),
        [`${name}: ${problem}`],
      );
    const special = encodeURIComponent(`p%w@o:r#d/${phraseOf(`tls.ok.${entry}.${name}`)}`);
    const accepted = [
      '',
      'sslmode=disable',
      'sslmode=require',
      `sslmode=verify-ca&sslrootcert=${READABLE}`,
      'sslmode=verify-full',
      `sslmode=verify-full&sslrootcert=${READABLE}&options=-c%20search_path%3Dapp`,
      `sslrootcert=${READABLE}&sslmode=verify-ca`,
    ].map((query) => urlWith(role, special, query));
    expect({
      accepted: accepted.map((value) =>
        revealOf(() => {
          const config = loadConnectionConfig(entry, { ...envFor(entry, env), [name]: value });
          return name === 'DATABASE_URL' ? config.db.url : config.dbRead?.url;
        }),
      ),
      queryRefused: queryRefused.map((value) => check(value, QUERY_MESSAGE)),
      rootUnreadable: rootUnreadable.map((value) => check(value, ROOT_MESSAGE)),
      badEscape: badEscape.map((value) => check(value, malformed(name).slice(name.length + 2))),
    }).toStrictEqual({
      accepted,
      queryRefused: queryRefused.map(() => []),
      rootUnreadable: rootUnreadable.map(() => []),
      badEscape: badEscape.map(() => []),
    });
  });
}

it('[ADR-0002 §5; 路径 B 契约补充 2] 一个变量只报一条：查询参数问题先于读不到的 sslrootcert；坏 URL 只报格式；admin 两个库与 Redis 的问题按顺序', () => {
  const { env } = urlsOf('tls.together');
  expect({
    queryFirst: problemsOrWhat(
      () =>
        loadConnectionConfig('payout', {
          DATABASE_URL: urlWith('couli_payout', 'x', `sslmode=prefer&sslrootcert=${MISSING}`),
        }),
      [`DATABASE_URL: ${QUERY_MESSAGE}`],
    ),
    malformedOnly: problemsOrWhat(
      () =>
        loadConnectionConfig('payout', {
          DATABASE_URL: urlWith(
            'couli_payout',
            'p%word',
            `sslmode=verify-ca&sslrootcert=${MISSING}`,
          ),
        }),
      [malformed('DATABASE_URL')],
    ),
    ordered: problemsOrWhat(
      () =>
        loadConnectionConfig('admin', {
          DATABASE_URL: urlWith('couli_app', 'x', `sslmode=verify-full&sslrootcert=${MISSING}`),
          DATABASE_READ_URL: urlWith('couli_readonly', 'x', 'ssl%6dode=verify-full'),
          REDIS_URL: env.REDIS_URL,
        }),
      [`DATABASE_URL: ${ROOT_MESSAGE}`, `DATABASE_READ_URL: ${QUERY_MESSAGE}`],
    ),
  }).toStrictEqual({ queryFirst: [], malformedOnly: [], ordered: [] });
});
