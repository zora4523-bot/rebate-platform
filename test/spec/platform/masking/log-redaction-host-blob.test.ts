// Contract addendum P–S (B1-01u: the access-log hostname through the safety net; blob: URLs
// without the origin written twice)
//
// This addendum supplements the log-redaction contract in the header comment of
// apps/api/src/modules/platform/masking/index.ts, the review addendum A–L in
// log-redaction-review.test.ts and the addendum M–O in log-redaction-url.test.ts (规划/08 BR-ID-33
// 「日志中不得出现明文」; 规划/02 §12.3, §19 日志). Where they disagree, this addendum wins. It
// closes the two findings of the B1-01o code review (couli-runs/followups/
// B1-01c-url-path-and-trace-id.md items 7 and 8): the access log wrote `hostname` exactly as the
// client sent it in the Host header (Host: u13987654321.example → hostname u13987654321.example,
// addendum N kept it unchanged), and a blob: URL object was written as its origin followed by its
// pathname, which for blob: begins with that origin again (blob:https://x.example/<id> →
// https://x.examplehttps://x.example/<id>). The rule tests below pin every case with kit.ts
// `expectLine` (strict parse, hand-built expected record, toStrictEqual, the sensitive-name walk,
// the plaintext search as a second net; note that the second net skips "hostname" fields, so for
// P only the exact check counts).
//
// "The net", "a match", ORIGIN, PATH and "the decoded form" are as in addendum M.
//
// P. Access-log hostname. In "incoming request" (addendum F), `hostname` is Fastify's
//    request.hostname (the Host header up to the first ":", or up to and including the first "]"
//    when it begins with "["; the port is never part of it) with the PATH rule of M applied to it,
//    exactly as N applies it to `url`: the hostname is cut at every "/" (normally there is none,
//    so it is one segment), and a segment that has a match as written, or whose decoded form has
//    a match, is written as the single string "[REDACTED]"; every other segment is written
//    exactly as it is. So:
//      Host: u13987654321.example:8443        → "[REDACTED]"
//      Host: qzx7.vwk3%40exmpl-host.cn        → "[REDACTED]" (an e-mail address once decoded)
//      Host: [13987654321]:3000               → "[REDACTED]"
//      Host: a/13987654321                    → "a/[REDACTED]"
//    A hostname without a match (with or without a port in the Host header; IPv4; IPv6 in
//    square brackets; digits that are no personal number; the empty string) is written exactly
//    as Fastify gives it: localhost, api.x.example, 192.168.10.200, [::1], [2001:db8::7],
//    2024100500001.example. Nothing else in the access log changes (N, F).
// Q. blob: URLs. Wherever M writes a URL object, a URL object whose protocol is "blob:" is
//    written as the string "blob:" followed by INNER, where:
//    - when url.pathname is itself an absolute URL (new URL(url.pathname), without a base, does
//      not throw), INNER is what M (with this rule Q, so a blob: inside a blob: the same way)
//      writes for new URL(url.pathname): ORIGIN + PATH of the inner URL, never the origin twice,
//      no userinfo, no query string, no fragment;
//    - otherwise INNER is PATH applied to url.pathname.
//    The query string and the fragment of the blob: URL itself are never written (as in G).
//    Examples:
//      blob:https://x.example/0f8f…950e            → blob:https://x.example/0f8f…950e
//      blob:https://x.example/u/13987654321?x=1#h  → blob:https://x.example/u/[REDACTED]
//      blob:https://u13987654321.example:8443/abc  → blob:https://u[REDACTED].example:8443/abc
//      blob:https://ops@10.0.0.7/a                 → blob:https://10.0.0.7/a
//      blob:file:///x/13987654321                  → blob:null/x/[REDACTED]
//      blob:blob:https://u13987654321.example/a    → blob:blob:https://u[REDACTED].example/a
//      blob:null/abc → blob:null/abc; blob:foo → blob:foo; blob:13987654321 → blob:[REDACTED];
//      blob: → blob:
//    The string is then written by the rule of its place, as in M (free text under msg / message
//    / stack / err, where the net finds nothing more; single quotes for %j / %o / %O; JSON text
//    for the Nest adapter's non-string message). H still holds: a log call never throws, however
//    deeply blob: URLs are nested (50 levels are written in full).
// R. Other URLs whose origin is opaque ("null"): data:, mailto:, tel:, file:, javascript:,
//    about:, urn: and every other non-special scheme (including ones with an authority, such as
//    couli://host/path, whose host is not written) are unchanged: "null" followed by PATH applied
//    to url.pathname, as M writes them (data:text/plain,13987654321 → nulltext/[REDACTED];
//    file://13987654321.example/x → null/x; couli://u13987654321/a → null/a). Special schemes
//    other than blob: (http:, https:, ws:, wss:, ftp:) are unchanged too. The content of a
//    base64 data: URL is not decoded (the net never decodes base64, as for any other text);
//    待编排会话确认 (couli-runs/B1-01u/author-report.md).
// S. Nothing else changes: the rules of the original contract, A–L and M–O hold for everything
//    that is neither the access-log hostname nor a blob: URL object.
//
// Top-level it() only (规划/11 §4.3).
import { afterAll, expect, it } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  PinoNestLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/logging/index.ts';
import {
  KEPT,
  REDACTED,
  SAMPLES,
  capture,
  errorShape,
  expectLine,
  parseStrict,
  snapshotOf,
} from './kit.ts';

/** pino's typings reject non-string messages; its runtime accepts them. */
type LooseLog = (...args: unknown[]) => void;

function loose(logger: RootLogger, level: 'info' | 'error' = 'info'): LooseLog {
  return logger[level].bind(logger) as LooseLog;
}

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const EMAIL_ENCODED = SAMPLES.alipayEmail.replace('@', '%40');
const DEEP_LEVELS = 50;
const PERCENT_PHONE = [...SAMPLES.phone]
  .map((digit) => `%${digit.charCodeAt(0).toString(16)}`)
  .join('');

/** blob: inputs (as given to new URL) and how Q writes them. */
const BLOBS = {
  uuid: [`blob:https://x.example/${UUID}`, `blob:https://x.example/${UUID}`],
  pathPhone: [
    `blob:https://x.example/u/${SAMPLES.phone}?x=1#h`,
    `blob:https://x.example/u/${REDACTED}`,
  ],
  hostPhone: [
    `blob:https://u${SAMPLES.phone}.example:8443/abc`,
    `blob:https://u${REDACTED}.example:8443/abc`,
  ],
  ipv4: ['blob:http://192.168.10.200:8080/abc', 'blob:http://192.168.10.200:8080/abc'],
  userinfo: ['blob:https://ops@10.0.0.7/a', 'blob:https://10.0.0.7/a'],
  emailEncoded: [
    `blob:https://x.example/cb/${EMAIL_ENCODED}/done`,
    `blob:https://x.example/cb/${REDACTED}/done`,
  ],
  idSpaced: [
    `blob:https://x.example/id/${SAMPLES.idNo.slice(0, 6)} ${SAMPLES.idNo.slice(6)}`,
    `blob:https://x.example/id/${REDACTED}`,
  ],
  card: [
    `blob:https://x.example/c/x${SAMPLES.bankCard}/a`,
    `blob:https://x.example/c/${REDACTED}/a`,
  ],
  ftp: ['blob:ftp://x.example/a', 'blob:ftp://x.example/a'],
  file: [`blob:file:///x/${SAMPLES.phone}`, `blob:null/x/${REDACTED}`],
  data: [`blob:data:text/plain,${SAMPLES.phone}`, `blob:nulltext/${REDACTED}`],
  mailto: [`blob:mailto:${SAMPLES.alipayEmail}`, `blob:null${REDACTED}`],
  custom: [`blob:couli://u${SAMPLES.phone}/a`, 'blob:null/a'],
  nested: [
    `blob:blob:https://u${SAMPLES.phone}.example/a`,
    `blob:blob:https://u${REDACTED}.example/a`,
  ],
  deep: [
    `${'blob:'.repeat(DEEP_LEVELS)}https://x.example/u/${SAMPLES.phone}`,
    `${'blob:'.repeat(DEEP_LEVELS)}https://x.example/u/${REDACTED}`,
  ],
  opaqueNull: ['blob:null/abc', 'blob:null/abc'],
  opaqueWord: ['blob:foo', 'blob:foo'],
  opaquePhone: [`blob:${SAMPLES.phone}`, `blob:${REDACTED}`],
  empty: ['blob:', 'blob:'],
} as const;

type BlobName = keyof typeof BLOBS;

function blob(name: BlobName): URL {
  return new URL(BLOBS[name][0]);
}

function written(name: BlobName): string {
  return BLOBS[name][1];
}

it('[BR-ID-33] 日志（B1-01u 补充 Q）：blob: URL 对象写 blob: + 内层 URL（origin 只写一次，路径按段过安全网，不写 userinfo、查询串、片段）；内层不是 URL 时写 blob: + 路径；嵌套 blob: 逐层同样写', () => {
  const names = Object.keys(BLOBS) as BlobName[];
  const key = (name: BlobName): string => `${name}_link`;
  const record = Object.fromEntries(names.map((name) => [key(name), blob(name)]));
  const before = names.map((name) => snapshotOf(record[key(name)] as URL));
  const hrefs = names.map((name) => (record[key(name)] as URL).href);
  const { logger, lines } = capture();
  logger.info(record, 'blobs');
  expect(lines).toHaveLength(1);
  expectLine(lines[0], {
    level: 30,
    ...Object.fromEntries(names.map((name) => [key(name), written(name)])),
    msg: 'blobs',
  });
  // The caller's URL objects are not modified.
  expect(names.map((name) => snapshotOf(record[key(name)] as URL))).toEqual(before);
  expect(names.map((name) => (record[key(name)] as URL).href)).toEqual(hrefs);
});

it('[BR-ID-33] 日志（B1-01u 补充 Q）：嵌套对象、数组、toJSON 返回值、错误属性、child() 序列化器输出、child() 与 setBindings() 绑定里的 blob: URL 同样只写一次 origin；敏感名下仍是 [REDACTED]', () => {
  const { logger, lines } = capture();
  const failure = Object.assign(new Error('upload failed'), { target: blob('hostPhone') });
  logger.info(
    {
      order_id: KEPT.order_id,
      nested: { deep: { target: blob('uuid'), more: [blob('pathPhone'), blob('nested')] } },
      list: [blob('userinfo'), { href: blob('emailEncoded') }, [blob('file')]],
      holder: { toJSON: (): unknown => blob('idSpaced') },
      failure,
      phone: blob('pathPhone'),
    },
    'structured',
  );
  logger
    .child({}, { serializers: { target: (value: unknown) => new URL(String(value)) } })
    .info({ target: BLOBS.card[0] }, 'serialized');
  logger.child({ link: blob('hostPhone'), ctx: { links: [blob('data')] } }).info('bound');
  const child = logger.child({ user_id: KEPT.user_id });
  child.setBindings({ link: blob('custom') });
  child.info('set');
  expect(lines).toHaveLength(4);
  expectLine(lines[0], {
    level: 30,
    order_id: KEPT.order_id,
    nested: { deep: { target: written('uuid'), more: [written('pathPhone'), written('nested')] } },
    list: [written('userinfo'), { href: written('emailEncoded') }, [written('file')]],
    holder: written('idSpaced'),
    failure: errorShape('Error', failure, { target: written('hostPhone') }),
    phone: REDACTED,
    msg: 'structured',
  });
  expectLine(lines[1], { level: 30, target: written('card'), msg: 'serialized' });
  expectLine(lines[2], {
    level: 30,
    link: written('hostPhone'),
    ctx: { links: [written('data')] },
    msg: 'bound',
  });
  expectLine(lines[3], {
    level: 30,
    user_id: KEPT.user_id,
    link: written('custom'),
    msg: 'set',
  });
});

it('[BR-ID-33] 日志（B1-01u 补充 Q）：printf 的 %s、%j、%o、%O 参数，Nest 适配器的参数与非字符串消息，以及自由文本位置（err、message、对象自带的 msg、消息参数）里的 blob: URL 只写一次 origin', () => {
  const { logger, lines } = capture();
  logger.info(
    'a %s b %j c %o d %O',
    blob('hostPhone'),
    [blob('uuid')],
    { link: blob('pathPhone') },
    blob('opaqueWord'),
  );
  const nest = new PinoNestLogger(logger);
  nest.warn('upload', blob('userinfo'), { link: blob('nested') }, 'Upload');
  nest.log(blob('emailEncoded'), 'Upload');
  const log = loose(logger, 'error');
  log({ err: blob('pathPhone'), message: blob('ipv4') }, 'free');
  log({ msg: blob('opaquePhone') });
  log({ order_id: KEPT.order_id }, blob('hostPhone'));
  expect(lines).toHaveLength(6);
  expectLine(lines[0], {
    level: 30,
    msg:
      `a ${written('hostPhone')} b ["${written('uuid')}"] ` +
      `c {"link":"${written('pathPhone')}"} d '${written('opaqueWord')}'`,
  });
  expectLine(lines[1], {
    level: 40,
    context: 'Upload',
    params: [written('userinfo'), { link: written('nested') }],
    msg: 'upload',
  });
  expectLine(lines[2], { level: 30, context: 'Upload', msg: `"${written('emailEncoded')}"` });
  expectLine(lines[3], {
    level: 50,
    err: written('pathPhone'),
    message: written('ipv4'),
    msg: 'free',
  });
  expectLine(lines[4], { level: 50, msg: written('opaquePhone') });
  expectLine(lines[5], { level: 50, order_id: KEPT.order_id, msg: written('hostPhone') });
});

it('[BR-ID-33] 日志（B1-01u 补充 R、S，反例）：origin 为 null 的其他 scheme（data:、mailto:、file:、javascript:、about:、urn:、自定义 scheme）与 ws:、ftp: 的 URL 照补充 M 写出，不变', () => {
  const cases: readonly (readonly [string, string])[] = [
    [`data:text/plain,${SAMPLES.phone}`, `nulltext/${REDACTED}`],
    [`data:,${SAMPLES.alipayEmail}`, `null${REDACTED}`],
    ['data:text/plain;base64,aGVsbG8=', 'nulltext/plain;base64,aGVsbG8='],
    [`mailto:a@b.cn?cc=${SAMPLES.alipayEmail}`, `null${REDACTED}`],
    [`file:///home/${SAMPLES.phone}/x`, `null/home/${REDACTED}/x`],
    [`file://${SAMPLES.phone}.example/x`, 'null/x'],
    [`couli://u${SAMPLES.phone}/a`, 'null/a'],
    [`couli://${SAMPLES.phone}@h/p`, 'null/p'],
    [`javascript:alert(${SAMPLES.phone})`, `null${REDACTED}`],
    ['about:blank', 'nullblank'],
    [`urn:x:${SAMPLES.phone}`, `null${REDACTED}`],
    [`ws://u${SAMPLES.phone}.example/a`, `ws://u${REDACTED}.example/a`],
    ['ftp://x.example/a', 'ftp://x.example/a'],
  ];
  const { logger, lines } = capture();
  logger.info({ links: cases.map(([input]) => new URL(input)) }, 'opaque');
  loose(logger)('%s %j', new URL(cases[0]?.[0] ?? ''), new URL(cases[5]?.[0] ?? ''));
  expect(lines).toHaveLength(2);
  expectLine(lines[0], { level: 30, links: cases.map(([, output]) => output), msg: 'opaque' });
  expectLine(lines[1], {
    level: 30,
    msg: `${cases[0]?.[1] ?? ''} '${cases[5]?.[1] ?? ''}'`,
  });
});

it('[BR-ID-33] 日志（B1-01u 补充 Q，补充用例）：内层不是绝对 URL 的 blob: 路径同样逐段解码判断——百分号编码的邮箱、号码整段替换', () => {
  const cases: readonly (readonly [string, string])[] = [
    [`blob:null/cb/${EMAIL_ENCODED}`, `blob:null/cb/${REDACTED}`],
    [`blob:foo/u/${PERCENT_PHONE}/x`, `blob:foo/u/${REDACTED}/x`],
  ];
  const { logger, lines } = capture();
  logger.info({ links: cases.map(([input]) => new URL(input)) }, 'opaque blob');
  loose(logger)('%s', new URL(cases[0]?.[0] ?? ''));
  expect(lines).toHaveLength(2);
  expectLine(lines[0], { level: 30, links: cases.map(([, output]) => output), msg: 'opaque blob' });
  expectLine(lines[1], { level: 30, msg: cases[0]?.[1] ?? '' });
});

// Access log (addendum P). createHttpApp is loaded at run time by URL, as in
// log-redaction-review.test.ts: bootstrap.ts needs the decorator settings of apps/api, which the
// `test` TypeScript project does not have, so only the shape used here is declared. One app is
// shared by the two access-log tests (closed in afterAll) to keep this file fast.
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(request: {
    method: 'GET';
    url: string;
    headers: Record<string, string>;
  }): Promise<{ readonly statusCode: number }>;
}

type CreateHttpApp = (
  entry: 'api',
  overrides: { logger: RootLogger; config: ReturnType<typeof loadConfig> },
) => Promise<HttpApp>;

const BOOTSTRAP = new URL('../../../../apps/api/src/bootstrap.ts', import.meta.url).href;
const TRACE_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

let shared: Promise<{ app: HttpApp; lines: string[] }> | undefined;

function sharedApp(): Promise<{ app: HttpApp; lines: string[] }> {
  shared ??= (async () => {
    const { createHttpApp } = (await import(BOOTSTRAP)) as { createHttpApp: CreateHttpApp };
    const { logger, lines } = capture();
    const app = await createHttpApp('api', { logger, config: loadConfig({ APP_ENV: 'test' }) });
    await app.init();
    return { app, lines };
  })();
  return shared;
}

afterAll(async () => {
  if (shared !== undefined) await (await shared).app.close();
});

/** Sends GET /healthz once per Host header; returns the access-log lines and status codes. */
async function accessLog(
  hosts: readonly string[],
): Promise<{ lines: string[]; statusCodes: number[] }> {
  const { app, lines } = await sharedApp();
  const start = lines.length;
  const statusCodes: number[] = [];
  for (const host of hosts) {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { host, 'x-trace-id': TRACE_ID },
    });
    statusCodes.push(response.statusCode);
  }
  return { lines: lines.slice(start), statusCodes };
}

function expectAccessLines(lines: readonly string[], index: number, hostname: string): void {
  expectLine(lines[index * 2], {
    level: 30,
    reqId: TRACE_ID,
    req: { method: 'GET', url: '/healthz', hostname, remoteAddress: '127.0.0.1' },
    msg: 'incoming request',
  });
  // responseTime is Fastify's own timing; pinned to 0 before the exact check (as in
  // log-redaction-review.test.ts) so that its digits cannot match a sample piece.
  const completed = lines[index * 2 + 1] ?? '';
  const responseTime = (parseStrict(completed) as Record<string, unknown>)['responseTime'];
  expect(typeof responseTime === 'number' && responseTime >= 0).toBe(true);
  expectLine(completed.replace(/"responseTime":[^,}]+/, '"responseTime":0'), {
    level: 30,
    reqId: TRACE_ID,
    res: { statusCode: 200 },
    responseTime: 0,
    msg: 'request completed',
  });
}

async function expectHostnames(cases: readonly (readonly [string, string])[]): Promise<void> {
  const { lines, statusCodes } = await accessLog(cases.map(([host]) => host));
  expect({ lines: lines.length, statusCodes }).toEqual({
    lines: cases.length * 2,
    statusCodes: cases.map(() => 200),
  });
  cases.forEach(([, hostname], index) => {
    expectAccessLines(lines, index, hostname);
  });
}

it('[BR-ID-33] 访问日志（B1-01u 补充 P）：hostname（取自客户端 Host 头）按路径段规则过安全网——带端口、连字符或空格分隔的手机号、邮箱、只在解码后才命中的邮箱与号码、身份证号、银行卡号、方括号写法、含 / 的 Host 整段替换', async () => {
  await expectHostnames([
    [SAMPLES.phone, REDACTED],
    [`u${SAMPLES.phone}.example:8443`, REDACTED],
    ['u139-8765-4321.example', REDACTED],
    [`+86 ${SAMPLES.contactPhone}`, REDACTED],
    [SAMPLES.alipayEmail, REDACTED],
    [`${SAMPLES.alipayEmail}:8080`, REDACTED],
    [EMAIL_ENCODED, REDACTED],
    // no digit anywhere: the e-mail pattern alone must catch these
    ['qzx.vwk@exmpl-host.cn', REDACTED],
    ['qzx.vwk%40exmpl-host.cn:8080', REDACTED],
    [`${PERCENT_PHONE}.example`, REDACTED],
    [`${SAMPLES.idNo}.example`, REDACTED],
    [`${SAMPLES.idNo15}.example:443`, REDACTED],
    [`x${SAMPLES.bankCard}.example`, REDACTED],
    [`[${SAMPLES.phone}]:3000`, REDACTED],
    [`a/${SAMPLES.phone}`, `a/${REDACTED}`],
  ]);
}, 30_000);

it('[BR-ID-33] 访问日志（B1-01u 补充 P、S，反例）：不含个人数据的 hostname 逐字不变——localhost、带端口的域名、IPv4、IPv6 方括号写法、不是个人号码的数字、编码后的空格', async () => {
  await expectHostnames([
    ['localhost', 'localhost'],
    ['localhost:80', 'localhost'],
    ['api.x.example:8443', 'api.x.example'],
    ['192.168.10.200:8080', '192.168.10.200'],
    ['[::1]:3000', '[::1]'],
    ['[2001:db8::7]', '[2001:db8::7]'],
    ['2024100500001.example', '2024100500001.example'],
    ['20000000001.example', '20000000001.example'],
    ['a%20b.example', 'a%20b.example'],
    ['xn--fiqs8s.example', 'xn--fiqs8s.example'],
  ]);
}, 30_000);

it('[BR-ID-33] 访问日志（B1-01u 补充 P，补充用例）：hostname 只在原文命中、解码一次后不再命中时也整段替换（u13987654321%30.example）', async () => {
  await expectHostnames([
    [`u${SAMPLES.phone}%30.example`, REDACTED],
    [`u${SAMPLES.phone}%30.example:8443`, REDACTED],
  ]);
}, 30_000);
