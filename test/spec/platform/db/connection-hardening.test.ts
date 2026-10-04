// Contract addendum 3 (code review round 5, path B) — the certificate name is checked against
// the URL host; connection fields refuse control characters. Decided by the orchestration
// session on 2026-10-04. It amends section 4 of addendum 2 (connection-tls.test.ts; the exact
// verify-full shape asserted in connection-tls.int.test.ts is revised with it) and the field
// rules of addendum 1 (connection-params.test.ts); the header of
// apps/api/src/modules/platform/db/index.ts is not edited. Basis: ADR-0002 §5 (登录强制 SSL 和
// 口令认证; DATABASE_URL of staging and prod names an internal address); ADR-0001 §4.2 第 11 项
// (只读从库用单独的 dbRead). Found by the code review:
//   (a) pg sets the TLS servername only for a host name, never for an IP literal, and Node then
//       checks the certificate name against 'localhost': with DATABASE_URL on 10.0.0.10 and
//       sslmode=verify-full, a certificate for DNS:localhost was accepted and the correct one
//       (IP Address:10.0.0.10) refused.
//   (b) pg writes options and the other startup fields NUL-terminated into the startup
//       message: `options=-c%20default_transaction_read_only%3Doff%00application_name%00report`
//       on DATABASE_READ_URL split the message, the server's default for the session became
//       read_only=off, and after RESET ALL a write through dbRead succeeded (the contract
//       requires SQLSTATE 25006).
//
// 1. verify-full checks the certificate against the host of the URL. Let H be the URL's
//    hostname exactly as the implementation hands it to pg as `host` (addendum 2 §1; percent
//    escapes in a host are not decoded and the URL parser refuses control characters there).
//    For sslmode=verify-full the ssl object given to pg is exactly:
//      { rejectUnauthorized: true,
//        ca: <sslrootcert text>                      only when sslrootcert is given,
//        servername: H                               only when H is not an IP literal
//                                                    (node:net isIP(H) === 0) — SNI,
//        checkServerIdentity: (_name, cert) => tls.checkServerIdentity(H, cert) }
//    The identity check never depends on the first argument (pg passes no servername for an IP,
//    Node then passes 'localhost'): an IP host is matched against the certificate's IP Address
//    entries, a name against its DNS entries — Node's own rules, applied to H. It returns
//    undefined, or Node's Error (code ERR_TLS_CERT_ALTNAME_INVALID, `host` equal to H).
//    disable, require and verify-ca are unchanged (verify-ca checks the chain only, its
//    checkServerIdentity returns undefined for every certificate).
//    Observable at tls.connect (connection-hardening.int.test.ts): apart from `socket`, the
//    options pg hands over have exactly the keys above for verify-full; `servername` is H for a
//    host name in every TLS mode (pg sets it there anyway) and absent for an IP; calling the
//    recorded checkServerIdentity with any first argument ('localhost', H, another name) and a
//    certificate object ({ subject: { CN }, subjectaltname }) gives exactly what
//    tls.checkServerIdentity(H, cert) gives. In particular, for H = 10.0.0.10: DNS:localhost
//    fails, DNS:10.0.0.10 fails, IP Address:10.0.0.11 fails, IP Address:10.0.0.10 passes; for
//    H = db.internal: DNS:localhost fails, IP Address:10.0.0.10 fails, DNS:db.internal passes.
// 2. Control characters. A value handed to the driver must not contain a C0 control character
//    (U+0000–U+001F) or U+007F after decoding. Checked fields of DATABASE_URL (every entry) and
//    DATABASE_READ_URL (admin): user and database (percent-decoded), the user-info password
//    (percent-decoded) and the `password` query value (both, even when the query one wins),
//    options (form-decoded, so `%00`, `%0A` and the like count). Not checked: sslpassword (pg
//    ignores it), sslrootcert (read here, never handed to pg), the host (see 1).
//    application_name is fixed by this module (section 1) and never comes from the URL. Raw tab
//    and newline characters are removed by the WHATWG URL parser before anything else and so
//    never arrive. Anything else is allowed, e.g. spaces, `=`, `%25` (a literal %), `+`
//    (a space in a query value) and non-ASCII letters.
//    A URL with such a field is one problem of `loadConnectionConfig`, exactly:
//      `<NAME>: connection fields may not contain control characters`
//    (never any part of the value; ConfigError as in section 1, no cause), so no pool is
//    created and no connection is opened.
// 3. One problem per variable, first match wins: malformed (section 1 and addendum 2 §2) →
//    query parameters (addendum 2 §5) → control characters → sslrootcert could not be read
//    (the CA file is not read for a URL refused before it). Variables in the usual order.
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

const CONTROL_MESSAGE = 'connection fields may not contain control characters';
const QUERY_MESSAGE =
  'query parameters may only be sslmode (disable, require, verify-ca or verify-full), sslrootcert (required by verify-ca, allowed with verify-full), options, password or sslpassword, each at most once and with a literal name';
const ROOT_MESSAGE = 'sslrootcert could not be read';
/** The query string the code review used to split the startup message (finding S1). */
const REVIEW_OPTIONS =
  'options=-c%20default_transaction_read_only%3Doff%00application_name%00report';

const READABLE = encodeURIComponent(fileURLToPath(import.meta.url));
const MISSING = encodeURIComponent(
  fileURLToPath(new URL('./no-such-ca-file.pem', import.meta.url)),
);

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

/** A postgres URL whose user, user-info password, database and query are written as given. */
function urlOf(user: string, rawPassword: string, database: string, query: string): string {
  return `postgres://${user}:${rawPassword}@127.0.0.1:1/${database}${query === '' ? '' : `?${query}`}`;
}

const CASES: readonly (readonly [VarName, Entry])[] = [
  ...ENTRIES.map((entry) => ['DATABASE_URL', entry] as const),
  ['DATABASE_READ_URL', 'admin'],
];

for (const [name, entry] of CASES) {
  it(`[ADR-0001 §4.2 #11; ADR-0002 §5; 路径 B 契约补充 3] ${entry} 的 ${name}：解码后的用户名、库名、口令（userinfo 与查询参数 password）、options 含 C0 控制字符或 U+007F 时只报「connection fields may not contain control characters」一条——评审拆分启动报文的 options（%00）、%0A、%01、%09、%0D、%1F、%7F 都在内；空格、=、%25、加号、非 ASCII 字母照收且原样保留`, () => {
    const { env } = urlsOf(`hardening.${entry}.${name}`);
    const role =
      name === 'DATABASE_URL'
        ? entry === 'payout'
          ? 'couli_payout'
          : 'couli_app'
        : 'couli_readonly';
    const pw = encodeURIComponent(phraseOf(`hardening.${entry}.${name}.pw`));
    const refused = [
      urlOf(role, pw, 'couli', REVIEW_OPTIONS),
      urlOf(role, pw, 'couli', `sslmode=verify-full&${REVIEW_OPTIONS}`),
      urlOf(role, pw, 'couli', 'options=-c%20statement_timeout%3D1%0A'),
      urlOf(role, pw, 'couli', 'options=%00'),
      urlOf(role, pw, 'couli', 'options=-c%20search_path%3Dapp%01'),
      urlOf(role, pw, 'couli', 'options=-c%09search_path%3Dapp'),
      urlOf(role, pw, 'couli', 'options=-c%20search_path%3Dapp%0D'),
      urlOf(role, pw, 'couli', 'options=-c%20search_path%3Dapp%1F'),
      urlOf(role, pw, 'couli', 'options=-c%20search_path%3Dapp%7F'),
      urlOf(`${role}%00`, pw, 'couli', ''),
      urlOf(`${role}%00application_name%00x`, pw, 'couli', 'sslmode=require'),
      urlOf(`${role}%1F`, pw, 'couli', ''),
      urlOf(role, pw, 'couli%00options%00-c', ''),
      urlOf(role, pw, 'couli%0A', 'sslmode=disable'),
      urlOf(role, pw, 'couli%7F', ''),
      urlOf(role, `${pw}%00`, 'couli', ''),
      urlOf(role, `%00${pw}`, 'couli', 'sslmode=verify-full'),
      urlOf(role, `${pw}%0A`, 'couli', ''),
      urlOf(role, `${pw}%7F`, 'couli', ''),
      urlOf(role, 'not-this-one', 'couli', `password=${pw}%00`),
      urlOf(role, 'not-this-one', 'couli', `password=%0D${pw}`),
      urlOf(role, `${pw}%00`, 'couli', `password=${pw}`),
      urlOf(role, pw, 'couli', `sslmode=verify-ca&sslrootcert=${READABLE}&options=a%00b`),
    ];
    const check = (value: string): string[] =>
      problemsOrWhat(
        () => loadConnectionConfig(entry, { ...envFor(entry, env), [name]: value }),
        [`${name}: ${CONTROL_MESSAGE}`],
      );
    const accepted = [
      urlOf(role, pw, 'couli', 'options=-c%20search_path%3Dapp%20-c%20statement_timeout%3D5000'),
      urlOf(role, pw, 'couli', 'options=-c+application_name%3Da%25b'),
      urlOf(role, pw, 'couli', 'options=-c%20search_path%3D%C3%A9t%C3%A9'),
      urlOf(role, `${pw}%20%25%3D`, 'couli', ''),
      urlOf(role, 'not-this-one', 'couli', `password=${pw}%20%2B`),
      urlOf(`${role}%20x`, pw, 'cou%20li%25', 'sslmode=verify-full'),
      urlOf(role, pw, 'couli', `sslmode=verify-full&sslrootcert=${READABLE}&sslpassword=a%00b`),
    ];
    expect({
      refused: refused.map(check),
      accepted: accepted.map((value) =>
        revealOf(() => {
          const config = loadConnectionConfig(entry, { ...envFor(entry, env), [name]: value });
          return name === 'DATABASE_URL' ? config.db.url : config.dbRead?.url;
        }),
      ),
    }).toStrictEqual({
      refused: refused.map(() => []),
      accepted,
    });
  });
}

it('[ADR-0002 §5; 路径 B 契约补充 3] 一个变量只报一条：格式错误先于控制字符，查询参数问题先于控制字符，控制字符先于读不到的 sslrootcert；admin 两个库与 Redis 的问题按顺序', () => {
  const { env } = urlsOf('hardening.together');
  const payout = (value: string, problems: readonly string[]): string[] =>
    problemsOrWhat(() => loadConnectionConfig('payout', { DATABASE_URL: value }), problems);
  expect({
    malformedFirst: payout(urlOf('couli_payout', 'p%word', 'couli', REVIEW_OPTIONS), [
      malformed('DATABASE_URL'),
    ]),
    malformedUser: payout(urlOf('couli%00%zz', 'x', 'couli', ''), [malformed('DATABASE_URL')]),
    queryFirst: payout(urlOf('couli_payout', 'x', 'couli', `${REVIEW_OPTIONS}&binary=false`), [
      `DATABASE_URL: ${QUERY_MESSAGE}`,
    ]),
    queryFirstUser: payout(urlOf('couli%00payout', 'x', 'couli', 'sslmode=prefer'), [
      `DATABASE_URL: ${QUERY_MESSAGE}`,
    ]),
    controlBeforeRoot: payout(
      urlOf('couli_payout', 'x', 'couli', `sslmode=verify-full&sslrootcert=${MISSING}&options=%00`),
      [`DATABASE_URL: ${CONTROL_MESSAGE}`],
    ),
    controlBeforeRootUser: payout(
      urlOf('couli%0Apayout', 'x', 'couli', `sslmode=verify-ca&sslrootcert=${MISSING}`),
      [`DATABASE_URL: ${CONTROL_MESSAGE}`],
    ),
    admin: problemsOrWhat(
      () =>
        loadConnectionConfig('admin', {
          DATABASE_URL: urlOf('couli_app', 'x', 'couli%00', ''),
          DATABASE_READ_URL: urlOf('couli_readonly', 'x', 'couli', REVIEW_OPTIONS),
          REDIS_URL: 'http://127.0.0.1:1/0',
        }),
      [
        `DATABASE_URL: ${CONTROL_MESSAGE}`,
        `DATABASE_READ_URL: ${CONTROL_MESSAGE}`,
        malformed('REDIS_URL'),
      ],
    ),
    adminMixed: problemsOrWhat(
      () =>
        loadConnectionConfig('admin', {
          DATABASE_URL: urlOf(
            'couli_app',
            'x',
            'couli',
            `sslmode=verify-full&sslrootcert=${MISSING}`,
          ),
          DATABASE_READ_URL: urlOf('couli_readonly', 'x', 'couli', 'options=%7F'),
          REDIS_URL: env.REDIS_URL,
        }),
      [`DATABASE_URL: ${ROOT_MESSAGE}`, `DATABASE_READ_URL: ${CONTROL_MESSAGE}`],
    ),
    readIgnored: revealOf(
      () =>
        loadConnectionConfig('api', {
          ...envFor('api', env),
          DATABASE_READ_URL: urlOf('couli_readonly', 'x', 'couli', REVIEW_OPTIONS),
        }).db.url,
    ),
  }).toStrictEqual({
    malformedFirst: [],
    malformedUser: [],
    queryFirst: [],
    queryFirstUser: [],
    controlBeforeRoot: [],
    controlBeforeRootUser: [],
    admin: [],
    adminMixed: [],
    readIgnored: env.DATABASE_URL,
  });
});
