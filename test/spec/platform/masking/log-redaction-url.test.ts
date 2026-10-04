// Contract addendum M–O (B1-01o: URL objects and access-log paths through the free-text net)
//
// This addendum supplements the log-redaction contract in the header comment of
// apps/api/src/modules/platform/masking/index.ts and the review addendum A–L in
// log-redaction-review.test.ts (规划/08 BR-ID-33「日志中不得出现明文」). Where they disagree, this
// addendum wins. It closes the channel left open by addendum G and F: the string written for a URL
// object (origin + pathname) went through the safety net only under msg / message / stack, so
// logger.info({ link: new URL('https://x.example/u/13987654321?ref=1') }) wrote the number as it
// is (couli-runs/followups/B1-01c-url-path-and-trace-id.md item 1). The rule tests below pin every
// case with kit.ts `expectLine` (strict parse, hand-built expected record, toStrictEqual, the
// sensitive-name walk, the plaintext search as a second net).
//
// "The net" below is the free-text safety net of the original contract: the two patterns
// (e-mail address, then number: mobile, ID number of 15 / 18, bank card of 16–19, with their
// separators, full-width digits and order of preference, addendum J included). "x has a match"
// means the net would change x (redactText(x) !== x in the implementation's terms).
//
// M. URL objects. Wherever a URL object is written below level 0 (addendum G: a field of the
//    logged object at any depth, an array element, a property of a plain object or array inside
//    them, an Error property, a toJSON result, a child() serializer result, a field of a binding
//    given to child() or setBindings() at any generation, a printf argument for %s / %j / %o /
//    %O, the Nest adapter's message and parameters, under err, under msg / message / stack, and
//    the message argument), it is written as the string ORIGIN + PATH, whatever the key (other
//    than a sensitive name, which still writes "[REDACTED]") and whether or not the place is
//    free text:
//    - ORIGIN is url.origin with the net applied to it (each match replaced by "[REDACTED]",
//      every other character kept): https://u13987654321.example → https://u[REDACTED].example.
//      An opaque origin stays "null" (mailto:, tel:, data:, file: and other non-special schemes).
//    - PATH is url.pathname cut at every "/" into segments (the "/" characters are kept; empty
//      segments stay empty). A segment is written as the single string "[REDACTED]" (the whole
//      segment, not only the match) when the segment as written in the pathname has a match, or
//      its decoded form has a match; otherwise it is written exactly as it is in the pathname
//      (still percent-encoded: /a%20b stays /a%20b).
//    - The decoded form of a segment is decoded once, the WHATWG way: every "%" followed by two
//      hexadecimal digits becomes that byte, every other character its UTF-8 bytes, and the bytes
//      are read as UTF-8 with U+FFFD for every invalid sequence (new TextDecoder().decode). It
//      never throws: %FF139%208765%204321 decodes to U+FFFD followed by "139 8765 4321", a mobile number.
//      Only one round: %2540 decodes to "%40", not "@".
//    - Examples: /u/13987654321 → /u/[REDACTED]; /cb/a.b%40example.com (an e-mail address once
//      decoded) → /cb/[REDACTED]; /id/110105%2019491231%20002X → /id/[REDACTED]; full-width digits
//      (percent-encoded by URL) → [REDACTED]; /a/u13987654321x/b → /a/[REDACTED]/b;
//      /u/13987654321%30 (a match only as written) → /u/[REDACTED]; mailto:a.b@example.com →
//      null[REDACTED]; tel:+86-15822446688 → null[REDACTED].
//    - The string is then written by the rule of its place: under msg / message / stack / err it
//      is free text and the net runs over it again (it finds nothing more); inside a printf %j /
//      %o / %O it is a string copy (single quotes for a bare string, addendum D); the Nest
//      adapter's non-string message is its JSON text (with double quotes).
//    - A URL with no match anywhere is written exactly as addendum G writes it (no change).
//    - Unchanged: a URL as the logged object itself or as a whole binding contributes no field
//      (addendum B); the URL rule comes before toJSON (addendum G); the caller's URL objects are
//      not modified.
// N. Access log. The `url` of "incoming request" (addendum F) is Fastify's routeOptions.url with
//    the PATH rule of M applied to it (cut at "/", a segment with a match as written or once
//    decoded becomes "[REDACTED]", parameter names such as :id are ordinary segments); so a route
//    registered as /v1/hotline/13987654321 is written /v1/hotline/[REDACTED] and /v1/users/:id
//    stays /v1/users/:id. "[unmatched]" is written as it is. Nothing else in the access log
//    changes.
// O. Nothing else changes: values that are not URL objects keep the rules of the original
//    contract and of A–L (a string under a non-free-text key is still written as it is).
//
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
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

const HOST = 'https://x.example';
const AT = '%40';
const EMAIL_ENCODED = SAMPLES.alipayEmail.replace('@', AT);
const ID_SPACED = `${SAMPLES.idNo.slice(0, 6)} ${SAMPLES.idNo.slice(6, 14)} ${SAMPLES.idNo.slice(14)}`;
const CARD_HYPHENS = SAMPLES.bankCard.replace(
  /^(\d{4})(\d{4})(\d{4})(\d{4})(\d{3})$/,
  '$1-$2-$3-$4-$5',
);
const FULL_WIDTH_PHONE = [...SAMPLES.phone]
  .map((d) => String.fromCodePoint(0xff10 + Number(d)))
  .join('');
const SPACED_PHONE = `${SAMPLES.phone.slice(0, 3)}%20${SAMPLES.phone.slice(3, 7)}%20${SAMPLES.phone.slice(7)}`;

/** Inputs (as given to new URL) and how M writes them. */
const URLS = {
  phone: [`${HOST}/u/${SAMPLES.phone}?ref=1#top`, `${HOST}/u/${REDACTED}`],
  emailEncoded: [`${HOST}/cb/${EMAIL_ENCODED}`, `${HOST}/cb/${REDACTED}`],
  emailPlain: [`${HOST}/cb/${SAMPLES.alipayEmail}/done`, `${HOST}/cb/${REDACTED}/done`],
  idSpaced: [`${HOST}/id/${ID_SPACED}`, `${HOST}/id/${REDACTED}`],
  id15: [`${HOST}/id/${SAMPLES.idNo15}/`, `${HOST}/id/${REDACTED}/`],
  card: [`${HOST}/card/${CARD_HYPHENS}/detail`, `${HOST}/card/${REDACTED}/detail`],
  fullWidth: [`${HOST}/u/${FULL_WIDTH_PHONE}`, `${HOST}/u/${REDACTED}`],
  wholeSegment: [`${HOST}/a/u${SAMPLES.phone}x/b`, `${HOST}/a/${REDACTED}/b`],
  rawOnly: [`${HOST}/u/${SAMPLES.phone}%30`, `${HOST}/u/${REDACTED}`],
  badUtf8: [`${HOST}/u/%FF${SPACED_PHONE}`, `${HOST}/u/${REDACTED}`],
  host: [`https://u${SAMPLES.phone}.example:8443/a`, `https://u${REDACTED}.example:8443/a`],
  mailto: [`mailto:${SAMPLES.alipayEmail}`, `null${REDACTED}`],
  tel: [`tel:+86-${SAMPLES.contactPhone}`, `null${REDACTED}`],
  cardNo: [`${HOST}/pay/${SAMPLES.cardNo}`, `${HOST}/pay/${REDACTED}`],
  // Several sensitive segments in one path: every one of them is replaced, not only the first.
  twoPhones: [
    `${HOST}/u/${SAMPLES.phone}/pay/${SAMPLES.alipayPhone}`,
    `${HOST}/u/${REDACTED}/pay/${REDACTED}`,
  ],
  emailAndCard: [
    `${HOST}/cb/${EMAIL_ENCODED}/card/${CARD_HYPHENS}/x${SAMPLES.idNo}`,
    `${HOST}/cb/${REDACTED}/card/${REDACTED}/${REDACTED}`,
  ],
} as const;

type UrlName = keyof typeof URLS;

/** A fresh URL object for one of the inputs above. */
function url(name: UrlName): URL {
  return new URL(URLS[name][0]);
}

/** What M writes for it. */
function written(name: UrlName): string {
  return URLS[name][1];
}

it('[BR-ID-33] 日志（B1-01o 补充 M）：URL 对象写出的 origin + pathname 按段过安全网——编码后的邮箱、空格分隔与全角号码、整段替换、只在原文或只在解码后命中、坏 UTF-8、主机名、mailto / tel', () => {
  const names = Object.keys(URLS) as UrlName[];
  // Keys get a suffix: phone and cardNo themselves are sensitive names.
  const key = (name: UrlName): string => `${name}_link`;
  const record = Object.fromEntries(names.map((name) => [key(name), url(name)]));
  const before = names.map((name) => snapshotOf(record[key(name)] as URL));
  const hrefs = names.map((name) => (record[key(name)] as URL).href);
  const { logger, lines } = capture();
  logger.info(record, 'urls');
  expect(lines).toHaveLength(1);
  expectLine(lines[0], {
    level: 30,
    ...Object.fromEntries(names.map((name) => [key(name), written(name)])),
    msg: 'urls',
  });
  expect(names.map((name) => snapshotOf(record[key(name)] as URL))).toEqual(before);
  expect(names.map((name) => (record[key(name)] as URL).href)).toEqual(hrefs);
});

it('[BR-ID-33] 日志（B1-01o 补充 M）：嵌套对象、数组、数组里的普通对象、错误属性、toJSON 返回值与 child() 序列化器输出里的 URL 对象同样按段过安全网（手机号、身份证号、银行卡号、邮箱）', () => {
  const { logger, lines } = capture();
  const failure = Object.assign(new Error('callback failed'), { target: url('card') });
  logger.info(
    {
      order_id: KEPT.order_id,
      nested: { deep: { target: url('phone'), kept: KEPT.name, more: [url('twoPhones')] } },
      mixed: { href: url('emailAndCard') },
      list: [url('id15'), { href: url('emailEncoded') }, [url('fullWidth')]],
      holder: { toJSON: (): unknown => url('idSpaced') },
      failure,
    },
    'structured',
  );
  logger
    .child({}, { serializers: { target: (value: unknown) => new URL(String(value)) } })
    .info({ target: URLS.cardNo[0] }, 'serialized');
  expect(lines).toHaveLength(2);
  expectLine(lines[0], {
    level: 30,
    order_id: KEPT.order_id,
    nested: { deep: { target: written('phone'), kept: KEPT.name, more: [written('twoPhones')] } },
    mixed: { href: written('emailAndCard') },
    list: [written('id15'), { href: written('emailEncoded') }, [written('fullWidth')]],
    holder: written('idSpaced'),
    failure: errorShape('Error', failure, { target: written('card') }),
    msg: 'structured',
  });
  expectLine(lines[1], { level: 30, target: written('cardNo'), msg: 'serialized' });
});

it('[BR-ID-33] 日志（B1-01o 补充 M）：child() 与孙 logger 的绑定、根 / 子 / 孙 logger 的 setBindings() 里的 URL 对象（含嵌套与数组）同样按段过安全网', () => {
  const binding = (): Record<string, unknown> => ({
    link: url('phone'),
    ctx: { links: [url('emailEncoded'), url('card')] },
  });
  const expected = {
    link: written('phone'),
    ctx: { links: [written('emailEncoded'), written('card')] },
  };
  const user = { user_id: KEPT.user_id };
  const a = capture();
  a.logger.child(binding()).info('child');
  a.logger.child(user).child(binding()).info('grandchild');
  const b = capture();
  b.logger.setBindings(binding());
  b.logger.info('root set');
  const c = capture();
  const child = c.logger.child(user);
  child.setBindings(binding());
  child.info('child set');
  const d = capture();
  const grandchild = d.logger.child({}).child(user);
  grandchild.setBindings(binding());
  grandchild.info('grandchild set');
  const lines = [...a.lines, ...b.lines, ...c.lines, ...d.lines];
  expect(lines).toHaveLength(5);
  expectLine(lines[0], { level: 30, ...expected, msg: 'child' });
  expectLine(lines[1], { level: 30, ...user, ...expected, msg: 'grandchild' });
  expectLine(lines[2], { level: 30, ...expected, msg: 'root set' });
  expectLine(lines[3], { level: 30, ...user, ...expected, msg: 'child set' });
  expectLine(lines[4], { level: 30, ...user, ...expected, msg: 'grandchild set' });
});

it('[BR-ID-33] 日志（B1-01o 补充 M）：printf 的 %s、%j、%o、%O 参数里的 URL 对象按段过安全网，不靠 msg 的整串安全网（编码后的邮箱、空格分隔的身份证号、全角号码、整段替换）', () => {
  const { logger, lines } = capture();
  logger.info(
    'a %s b %j c %o d %O',
    url('emailEncoded'),
    [url('idSpaced')],
    { link: url('fullWidth') },
    url('wholeSegment'),
  );
  logger.info('only %s', url('badUtf8'));
  expect(lines).toHaveLength(2);
  expectLine(lines[0], {
    level: 30,
    msg:
      `a ${written('emailEncoded')} b ["${written('idSpaced')}"] ` +
      `c {"link":"${written('fullWidth')}"} d '${written('wholeSegment')}'`,
  });
  expectLine(lines[1], { level: 30, msg: `only ${written('badUtf8')}` });
});

it('[BR-ID-33] 日志（B1-01o 补充 M）：Nest 适配器的参数（URL 本身、对象与数组里的 URL）与非字符串消息（URL）按段过安全网', () => {
  const { logger, lines } = capture();
  const nest = new PinoNestLogger(logger);
  nest.warn('callback', url('phone'), { link: url('card') }, [url('emailEncoded')], 'Callback');
  nest.log(url('idSpaced'), 'Callback');
  nest.error('payout', 'trace line', url('id15'), 'Payout');
  expect(lines).toHaveLength(3);
  expectLine(lines[0], {
    level: 40,
    context: 'Callback',
    params: [written('phone'), { link: written('card') }, [written('emailEncoded')]],
    msg: 'callback',
  });
  expectLine(lines[1], { level: 30, context: 'Callback', msg: `"${written('idSpaced')}"` });
  expectLine(lines[2], {
    level: 50,
    context: 'Payout',
    stack: 'trace line',
    params: [written('id15')],
    msg: 'payout',
  });
});

it('[BR-ID-33] 日志（B1-01o 补充 M）：自由文本位置（err、message、stack、对象自带的 msg、消息参数）里的 URL 对象先按段处理，再过整串安全网：整段替换，解码后才命中的也替换', () => {
  const { logger, lines } = capture();
  const log = loose(logger, 'error');
  log({ err: url('rawOnly') }, 'err');
  log({ err: { link: url('wholeSegment'), list: [url('badUtf8')] } }, 'err nested');
  log({ message: url('emailEncoded'), detail: { stack: [url('idSpaced')] } }, 'free');
  log({ msg: url('fullWidth') });
  log({ order_id: KEPT.order_id }, url('wholeSegment'));
  logger.child({ message: url('emailEncoded') }).warn('bound');
  expect(lines).toHaveLength(6);
  expectLine(lines[0], { level: 50, err: written('rawOnly'), msg: 'err' });
  expectLine(lines[1], {
    level: 50,
    err: { link: written('wholeSegment'), list: [written('badUtf8')] },
    msg: 'err nested',
  });
  expectLine(lines[2], {
    level: 50,
    message: written('emailEncoded'),
    detail: { stack: [written('idSpaced')] },
    msg: 'free',
  });
  expectLine(lines[3], { level: 50, msg: written('fullWidth') });
  expectLine(lines[4], { level: 50, order_id: KEPT.order_id, msg: written('wholeSegment') });
  expectLine(lines[5], { level: 40, message: written('emailEncoded'), msg: 'bound' });
});

it('[BR-ID-33] 日志（B1-01o 补充 M、O，反例）：不含个人数据的 URL 在字段、嵌套、数组、绑定、printf、Nest 参数与自由文本位置逐字按补充 G 写出；敏感名下仍是 [REDACTED]', () => {
  const plain: readonly (readonly [string, string])[] = [
    [
      'https://x.example:8443/v1/orders/2024100500001?phone=1#f',
      'https://x.example:8443/v1/orders/2024100500001',
    ],
    ['https://x.example/p/20000000001/items', 'https://x.example/p/20000000001/items'],
    ['https://x.example/a%20b/%E5%95%86%E5%93%81/', 'https://x.example/a%20b/%E5%95%86%E5%93%81/'],
    ['http://192.168.10.200:8080/', 'http://192.168.10.200:8080/'],
    ['https://x.example/sku/20000000000000000000', 'https://x.example/sku/20000000000000000000'],
    // decoded once only (M): %2540 is "%40", so this is not an e-mail address
    [
      'https://x.example/d/2026-10-05/p.q%2540exmpl.cn',
      'https://x.example/d/2026-10-05/p.q%2540exmpl.cn',
    ],
    ['mailto:', 'null'],
  ];
  const urls = (): URL[] => plain.map(([input]) => new URL(input));
  const out = plain.map(([, output]) => output);
  const { logger, lines } = capture();
  logger.info(
    {
      list: urls(),
      nested: { first: urls()[0] },
      message: urls()[1],
      err: urls()[2],
      phone: url('phone'),
    },
    'plain',
  );
  logger.child({ links: urls() }).info('bound');
  loose(logger)('go %s %j', urls()[0], urls()[2]);
  new PinoNestLogger(logger).warn('nest', urls(), 'Ctx');
  expect(lines).toHaveLength(4);
  expectLine(lines[0], {
    level: 30,
    list: out,
    nested: { first: out[0] },
    message: out[1],
    err: out[2],
    phone: REDACTED,
    msg: 'plain',
  });
  expectLine(lines[1], { level: 30, links: out, msg: 'bound' });
  expectLine(lines[2], { level: 30, msg: `go ${out[0] ?? ''} '${out[2] ?? ''}'` });
  expectLine(lines[3], { level: 40, context: 'Ctx', params: [out], msg: 'nest' });
});

// Access log (addendum N). createHttpApp is loaded at run time by URL, as in
// log-redaction-review.test.ts: bootstrap.ts needs the decorator settings of apps/api, which the
// `test` TypeScript project does not have, so only the shape used here is declared.
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(request: {
    method: 'GET';
    url: string;
    headers: Record<string, string>;
  }): Promise<{ readonly statusCode: number }>;
  getHttpAdapter(): {
    getInstance(): { get(path: string, handler: () => Promise<unknown>): unknown };
  };
}

type CreateHttpApp = (
  entry: 'api',
  overrides: { logger: RootLogger; config: ReturnType<typeof loadConfig> },
) => Promise<HttpApp>;

const BOOTSTRAP = new URL('../../../../apps/api/src/bootstrap.ts', import.meta.url).href;
const TRACE_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function expectAccessLines(
  lines: readonly string[],
  index: number,
  route: string,
  statusCode: number,
): void {
  expectLine(lines[index * 2], {
    level: 30,
    reqId: TRACE_ID,
    req: { method: 'GET', url: route, hostname: 'localhost', remoteAddress: '127.0.0.1' },
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
    res: { statusCode },
    responseTime: 0,
    msg: 'request completed',
  });
}

it('[BR-ID-33] 访问日志（B1-01o 补充 N）：url 写的路由模板按段过安全网（模板里的手机号、身份证号、银行卡号、邮箱、编码后的邮箱整段替换）；普通模板与 [unmatched] 不变', async () => {
  const routes: readonly (readonly [string, string, string, number])[] = [
    // [registered route, requested path, written url, status]
    [
      `/v1/u/${SAMPLES.phone}/pay/${SAMPLES.alipayPhone}`,
      `/v1/u/${SAMPLES.phone}/pay/${SAMPLES.alipayPhone}`,
      `/v1/u/${REDACTED}/pay/${REDACTED}`,
      200,
    ],
    [
      `/v1/cb/${SAMPLES.alipayEmail}/card/${CARD_HYPHENS}/:id`,
      `/v1/cb/${SAMPLES.alipayEmail}/card/${CARD_HYPHENS}/7`,
      `/v1/cb/${REDACTED}/card/${REDACTED}/:id`,
      200,
    ],
    [
      `/v1/hotline/${SAMPLES.phone}`,
      `/v1/hotline/${SAMPLES.phone}?ref=1`,
      `/v1/hotline/${REDACTED}`,
      200,
    ],
    [
      `/v1/contact/${SAMPLES.alipayEmail}`,
      `/v1/contact/${SAMPLES.alipayEmail}`,
      `/v1/contact/${REDACTED}`,
      200,
    ],
    [
      `/v1/cards/${CARD_HYPHENS}/:id`,
      `/v1/cards/${CARD_HYPHENS}/7`,
      `/v1/cards/${REDACTED}/:id`,
      200,
    ],
    [
      `/v1/ids/x${SAMPLES.idNo15}y/list`,
      `/v1/ids/x${SAMPLES.idNo15}y/list`,
      `/v1/ids/${REDACTED}/list`,
      200,
    ],
    // find-my-way matches a decoded request path against the registered text, so the
    // template /v1/mail/a%40b is reached by requesting /v1/mail/a%2540b.
    [
      `/v1/mail/${EMAIL_ENCODED}`,
      `/v1/mail/${EMAIL_ENCODED.replace('%', '%25')}`,
      `/v1/mail/${REDACTED}`,
      200,
    ],
    [
      '/v1/orders/:order_id/items',
      '/v1/orders/2024100500001/items',
      '/v1/orders/:order_id/items',
      200,
    ],
    ['', `/nowhere/${SAMPLES.phone}`, '[unmatched]', 404],
  ];
  const { createHttpApp } = (await import(BOOTSTRAP)) as { createHttpApp: CreateHttpApp };
  const { logger, lines } = capture();
  const app = await createHttpApp('api', { logger, config: loadConfig({ APP_ENV: 'test' }) });
  const statusCodes: number[] = [];
  let access: string[] = [];
  try {
    await app.init();
    const fastify = app.getHttpAdapter().getInstance();
    for (const [route] of routes) {
      if (route !== '') fastify.get(route, async () => ({ ok: true }));
    }
    const startup = lines.length;
    for (const [, path] of routes) {
      const response = await app.inject({
        method: 'GET',
        url: path,
        headers: { 'x-trace-id': TRACE_ID },
      });
      statusCodes.push(response.statusCode);
    }
    access = lines.slice(startup);
  } finally {
    await app.close();
  }
  expect({ lines: access.length, statusCodes }).toEqual({
    lines: routes.length * 2,
    statusCodes: routes.map(([, , , status]) => status),
  });
  routes.forEach(([, , route, status], index) => {
    expectAccessLines(access, index, route, status);
  });
}, 30_000);
