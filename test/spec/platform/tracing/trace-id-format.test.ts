// Rule tests for the format of the trace id the HTTP entries adopt from the client (B1-01p).
// Basis (原文 by SPEC_REF): 规划/04 §5 公共请求头 `X-Trace-Id` and the envelope's `trace_id`;
// 规划/03 §4.2 `X-Trace-Id`（客户端生成，便于对照）; 规划/02 §19 日志「pino redact 脱敏」; BR-ID-33
// 日志中不得出现明文. Scenario: a request header `x-trace-id: 13987654321` used to become the
// Fastify request id, i.e. the `reqId` of every access-log line and the `trace_id` of the
// response, so a phone number reached the logs in clear.
//
// Contract of `resolveTraceId(incoming: unknown): string`
// (apps/api/src/modules/platform/tracing/trace-id.ts; signature unchanged, used by bootstrap.ts as
// the Fastify genReqId on `request.headers['x-trace-id']`):
//
// 1. Adopted as is. The input is adopted only when it is a primitive string (typeof 'string')
//    and the WHOLE string is one of
//      (a) exactly 32 characters, each a hexadecimal digit, or
//      (b) exactly 36 characters in the UUID spelling 8-4-4-4-12: hexadecimal digits in groups of
//          8, 4, 4, 4 and 12, separated by single hyphen-minus characters (U+002D).
//    A hexadecimal digit is an ASCII character 0-9, a-f or A-F. Lower, upper and mixed case are
//    all adopted (iOS `UUID().uuidString` is upper case; Android and HarmonyOS clients usually
//    send lower case). No version or variant digit is checked (the nil UUID, a v7 UUID and any
//    32 hexadecimal digits are adopted). A string of 32 decimal digits is adopted too: it is
//    32 hexadecimal digits, and no phone number (11), ID number (15 / 18) or bank card number
//    (16-19) has that length, so it only appears when built on purpose (待编排会话确认).
//    The return value is then the input itself (===): no change of case, no trimming.
// 2. Everything else gets a new id: any other string (other lengths, other characters, hyphens
//    elsewhere or partly missing, leading / trailing / inner whitespace, line breaks, NUL,
//    braces, a "urn:uuid:" prefix, two ids joined by ", ", non-ASCII look-alikes such as
//    full-width digits or U+2010), and every value that is not a primitive string (undefined,
//    null, numbers, bigints, booleans, symbols, functions, arrays even of one well-formed value,
//    boxed strings, objects whose toString / valueOf return a well-formed value, proxies). The
//    input is never converted, unwrapped, trimmed or re-cased to make it fit.
// 3. A new id is a random UUID version 4 in lower case: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-
//    [89ab][0-9a-f]{3}-[0-9a-f]{12}$/, freshly drawn on every call (two calls with the same
//    input give two different ids) and never taken from the input. Its 122 random bits come
//    from a cryptographic source (node:crypto randomUUID is enough).
// 4. resolveTraceId never throws, whatever the input (a toString that throws, a proxy whose
//    every trap throws): such inputs simply get a new id.
// 5. HTTP entry (bootstrap.ts wiring, unchanged): the request id is resolveTraceId of the
//    header as Node delivers it, and it is the `trace_id` of the response envelope and the
//    `reqId` of both access-log lines ("incoming request", "request completed") of that request.
//    So a header that is not adopted never reaches the response or any log line.
//
// The request-header schema of the contract (contracts/openapi.yaml components TraceId,
// pattern ^[A-Za-z0-9_-]+$, maxLength 64) is not changed: request validation still lets other
// values through, the server only stops adopting them.
//
// Top-level it() only (规划/11 §4.3).
import { afterAll, expect, it } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { resolveTraceId } from '../../../../apps/api/src/modules/platform/tracing/index.ts';
import { SAMPLES, capture, parseStrict } from '../masking/kit.ts';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const UUID_LOWER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const UUID_UPPER = 'C56A4180-65AA-42EC-A945-5FD21DEC0538';
const HEX_LOWER = '7d444840a9dc4f2e8d7b1b0c6e5f4a39';
const HEX_UPPER = '7D444840A9DC4F2E8D7B1B0C6E5F4A39';

/** Every way the input could be read as text, lower-cased: a new id must not come from it. */
function textsOf(input: unknown): string[] {
  const out: string[] = [];
  const add = (read: () => unknown): void => {
    try {
      const text = read();
      if (typeof text === 'string') out.push(text.toLowerCase());
    } catch {
      // An input that cannot be read as text contributes nothing.
    }
  };
  add(() => (typeof input === 'symbol' ? input.description : String(input)));
  add(() => JSON.stringify(input));
  add(() => (Array.isArray(input) ? input.join('') : undefined));
  return out;
}

/** The input gets a new lower-case v4 UUID, a different one on a second call, not taken from it. */
function expectNewId(input: unknown, label: string): void {
  const first = resolveTraceId(input);
  const second = resolveTraceId(input);
  expect({ label, first: V4.test(first), second: V4.test(second), same: first === second }).toEqual(
    { label, first: true, second: true, same: false },
  );
  const found = textsOf(input).filter((text) => text.includes(first) || text.includes(second));
  expect({ label, found }).toEqual({ label, found: [] });
}

/** The input is adopted: the very same string comes back. */
function expectAdopted(input: string): void {
  expect({ input, out: resolveTraceId(input) }).toStrictEqual({ input, out: input });
}

it('[规划/04 §5][规划/03 §4.2] 合格的 x-trace-id 原样采用：8-4-4-4-12 的 UUID 与 32 位十六进制，小写、大写、大小写混合都原样返回（不改大小写），不查版本位与变体位（nil UUID、v7、全数字 32 位也采用）', () => {
  const adopted = [
    UUID_LOWER,
    UUID_UPPER,
    'c56A4180-65aa-42EC-a945-5fd21DEC0538',
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
    '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b',
    '12345678-1234-1234-1234-123456789012',
    HEX_LOWER,
    HEX_UPPER,
    '7d444840A9DC4f2e8d7b1b0c6e5f4A39',
    '0'.repeat(32),
    'F'.repeat(32),
    'abcdefABCDEF'.repeat(2) + '01234567',
    '12345678901234567890123456789012',
  ];
  for (const input of adopted) expectAdopted(input);
  // A new id fed back is adopted as is (it is a well-formed UUID).
  const generated = resolveTraceId(undefined);
  expectAdopted(generated);
});

it('[规划/04 §5][BR-ID-33] x-trace-id 是手机号、身份证号、银行卡号、邮箱等个人数据的形状时不采用，换成新生成的小写 v4 UUID（每次不同、不取自输入）', () => {
  const personal: Record<string, string> = {
    phone: SAMPLES.phone,
    phonePlus86: `+86${SAMPLES.phone}`,
    phone86: `86${SAMPLES.phone}`,
    phoneHyphens: '139-8765-4321',
    idNo18: SAMPLES.idNo,
    idNo18Digits: '110105194912310021',
    idNo18LowerX: '11010519491231002x',
    idNo15: SAMPLES.idNo15,
    card16: SAMPLES.cardNo,
    card17: '43922600123456781',
    card18: '622202123456789012',
    card19: SAMPLES.bankCard,
    email: SAMPLES.alipayEmail,
    alipayPhone: SAMPLES.alipayPhone,
    name: SAMPLES.realName,
  };
  for (const [label, input] of Object.entries(personal)) expectNewId(input, label);
});

it('[规划/04 §5] 不是 32 位十六进制也不是 8-4-4-4-12 写法的字符串不采用：长度差一位、连字符位置或个数不对、只省一部分连字符、非十六进制字母、下划线与旧格式示例值都换成新 UUID', () => {
  const nearMisses: Record<string, string> = {
    hex31: HEX_LOWER.slice(1),
    hex33: `${HEX_LOWER}0`,
    hex64: HEX_LOWER + HEX_LOWER,
    hex16: HEX_LOWER.slice(0, 16),
    uuid35: UUID_LOWER.slice(1),
    uuid37: `${UUID_LOWER}0`,
    uuidShortFirst: '0f8fad5-bd9cb-469f-a165-70867728950e',
    uuid84416: '0f8fad5b-d9cb-469f-a16570867728950e',
    uuidMissingFirstHyphen: '0f8fad5bd9cb-469f-a165-70867728950e',
    uuidOnlyFirstHyphen: '0f8fad5b-d9cb469fa16570867728950e',
    uuidExtraHyphen: '0f8fad5b-d9cb-469f-a165-7086-7728950e',
    uuidDoubleHyphen: '0f8fad5b--d9cb-469f-a165-70867728950e',
    uuidHyphenAtEnd: `${HEX_LOWER}----`,
    uuidHyphensShifted: '0f8fad5bd-9cb-469f-a165-70867728950e',
    hex32TrailingHyphen: `${HEX_LOWER}-`,
    hex32LeadingHyphen: `-${HEX_LOWER}`,
    letterG: `${HEX_LOWER.slice(0, 31)}g`,
    letterUpperG: `${'G'.repeat(32)}`,
    letterZInUuid: '0f8fad5b-d9cb-469f-a165-70867728950z',
    underscore: '0f8fad5b_d9cb_469f_a165_70867728950e',
    underscoreHex: `${HEX_LOWER.slice(0, 31)}_`,
    oldSampleA: 'trace-abc_123',
    oldSampleB: 'validation-trace',
    oldSampleC: 'A'.repeat(64),
    oneChar: 'a',
    word: 'abc',
  };
  for (const [label, input] of Object.entries(nearMisses)) expectNewId(input, label);
});

it('[规划/04 §5] 合格值外面包了东西也不采用、也不剥开：首尾空白、换行、NUL、花括号、urn:uuid: 前缀、逗号连接的两个值、全角数字与 U+2010 连字符都换成新 UUID（不是去壳后的那个值）', () => {
  const wrapped: Record<string, string> = {
    empty: '',
    leadingSpace: ` ${UUID_LOWER}`,
    trailingSpace: `${UUID_LOWER} `,
    leadingTab: `\t${HEX_LOWER}`,
    trailingNewline: `${UUID_LOWER}\n`,
    leadingNewline: `\n${UUID_LOWER}`,
    crlf: `${HEX_LOWER}\r\n`,
    newlineThenText: `${UUID_LOWER}\nextra`,
    innerSpace: '0f8fad5b d9cb 469f a165 70867728950e',
    nul: `${HEX_LOWER}\u0000`,
    braces: `{${UUID_LOWER}}`,
    urn: `urn:uuid:${UUID_LOWER}`,
    joined: `${UUID_LOWER}, ${UUID_UPPER}`,
    fullWidthDigit: `${HEX_LOWER.slice(0, 31)}０`,
    unicodeHyphen: UUID_LOWER.replaceAll('-', '‐'),
    quoted: `"${UUID_LOWER}"`,
  };
  for (const [label, input] of Object.entries(wrapped)) expectNewId(input, label);
});

it('[规划/04 §5] 不是原始字符串的入参一律换成新 UUID、不转换、不抛错：undefined、null、数字、bigint、布尔、symbol、函数、数组（含只有一个合格值的数组）、装箱字符串、toString 返回合格值的对象、toString 抛错的对象、处处抛错的 Proxy', () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('trap get');
      },
      has() {
        throw new Error('trap has');
      },
      ownKeys() {
        throw new Error('trap ownKeys');
      },
      getPrototypeOf() {
        throw new Error('trap getPrototypeOf');
      },
      getOwnPropertyDescriptor() {
        throw new Error('trap getOwnPropertyDescriptor');
      },
    },
  );
  const inputs: Record<string, unknown> = {
    undefined: undefined,
    null: null,
    number: 13987654321,
    bigint: 13987654321n,
    boolean: true,
    symbol: Symbol(UUID_LOWER),
    function: () => UUID_LOWER,
    arrayOne: [UUID_LOWER],
    arrayTwo: [UUID_LOWER, UUID_UPPER],
    arrayHex: [HEX_LOWER],
    boxed: Object(UUID_LOWER) as object,
    boxedHex: Object(HEX_UPPER) as object,
    toStringObject: { toString: () => UUID_LOWER },
    valueOfObject: { valueOf: () => HEX_LOWER, toString: () => HEX_LOWER },
    throwingToString: {
      toString(): string {
        throw new Error('no text');
      },
    },
    proxy: hostile,
  };
  for (const [label, input] of Object.entries(inputs)) {
    expect({ label, threw: threwOn(input) }).toEqual({ label, threw: false });
    expectNewId(input, label);
  }
});

function threwOn(input: unknown): boolean {
  try {
    resolveTraceId(input);
    return false;
  } catch {
    return true;
  }
}

it('[规划/04 §5] 新生成的 trace id 是小写 v4 UUID：256 次互不相同，122 个随机位每一位都出现过 0 和 1', () => {
  const ids = Array.from({ length: 256 }, () => resolveTraceId(undefined));
  expect(ids.filter((id) => !V4.test(id))).toEqual([]);
  expect(new Set(ids).size).toBe(256);
  const bits = ids.map((id) => {
    const hex = id.replaceAll('-', '');
    return [...hex].map((digit) => parseInt(digit, 16).toString(2).padStart(4, '0')).join('');
  });
  // Bits 48-51 hold the version (0100) and bits 64-65 the variant (10); the other 122 are random.
  const fixed = new Set([48, 49, 50, 51, 64, 65]);
  const stuck: number[] = [];
  for (let bit = 0; bit < 128; bit += 1) {
    if (fixed.has(bit)) continue;
    const seen = new Set(bits.map((row) => row.charAt(bit)));
    if (seen.size !== 2) stuck.push(bit);
  }
  expect(stuck).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// HTTP entry (contract 5). createHttpApp is loaded at run time by URL, as in
// test/spec/platform/masking/log-redaction-review.test.ts: bootstrap.ts needs the decorator
// settings of apps/api, which the `test` TypeScript project does not have. One api app over the
// in-memory root logger is shared by the HTTP tests of this file and closed at the end.

interface InjectResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Record<string, unknown>;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(request: {
    method: 'GET';
    url: string;
    headers: Record<string, string | string[]>;
  }): Promise<InjectResponse>;
}

type CreateHttpApp = (
  entry: 'api',
  overrides: { logger: RootLogger; config: ReturnType<typeof loadConfig> },
) => Promise<HttpApp>;

const BOOTSTRAP = new URL('../../../../apps/api/src/bootstrap.ts', import.meta.url).href;

interface Shared {
  readonly app: HttpApp;
  readonly lines: string[];
}

let shared: Promise<Shared> | undefined;

function sharedApp(): Promise<Shared> {
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

interface Exchange {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Record<string, unknown>;
  readonly lines: string[];
}

/** One GET through the shared app; returns the response and exactly its access-log lines. */
async function exchange(url: string, header: string | string[]): Promise<Exchange> {
  const { app, lines } = await sharedApp();
  const start = lines.length;
  const response = await app.inject({ method: 'GET', url, headers: { 'x-trace-id': header } });
  return {
    statusCode: response.statusCode,
    body: response.body,
    headers: response.headers,
    lines: lines.slice(start),
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The two access-log lines of one request, checked field by field with `reqId`. */
function expectAccessLines(
  lines: readonly string[],
  reqId: string,
  url: string,
  statusCode: number,
): void {
  expect(lines).toHaveLength(2);
  const [incoming, completed] = lines.map((line) => {
    expect(line.endsWith('\n')).toBe(true);
    const { time, pid, ...rest } = parseStrict(line) as Record<string, unknown>;
    expect({ time: ISO.test(String(time)), pid }).toEqual({ time: true, pid: process.pid });
    return rest;
  });
  expect(incoming).toStrictEqual({
    level: 30,
    entry: 'spec',
    env: 'test',
    reqId,
    req: { method: 'GET', url, hostname: 'localhost', remoteAddress: '127.0.0.1' },
    msg: 'incoming request',
  });
  const responseTime = completed?.['responseTime'];
  expect(typeof responseTime === 'number' && responseTime >= 0).toBe(true);
  expect({ ...completed, responseTime: 0 }).toStrictEqual({
    level: 30,
    entry: 'spec',
    env: 'test',
    reqId,
    res: { statusCode },
    responseTime: 0,
    msg: 'request completed',
  });
}

/** The healthz envelope with `trace_id`; `now` is whatever the clock said. */
function expectHealthz(result: Exchange, traceId: string): void {
  expect(result.statusCode).toBe(200);
  const body = parseStrict(result.body) as Record<string, unknown>;
  expect(body).toStrictEqual({
    code: 0,
    msg: '',
    data: { status: 'ok', entry: 'api', now: expect.stringMatching(ISO) as unknown },
    trace_id: traceId,
  });
}

it('[规划/04 §5][规划/02 §19][BR-ID-33] HTTP 入口：x-trace-id 是手机号 13987654321 时响应 trace_id 与访问日志两行的 reqId 是同一个新生成的 v4 UUID，响应与日志里都不出现该号码；身份证号、银行卡号同样；同一号码再请求一次得到另一个新 UUID；404 也一样', async () => {
  const personal = [SAMPLES.phone, SAMPLES.idNo, '110105194912310021', SAMPLES.bankCard];
  const seen: string[] = [];
  for (const header of personal) {
    for (let round = 0; round < 2; round += 1) {
      const result = await exchange('/healthz', header);
      const traceId = (parseStrict(result.body) as { trace_id?: unknown }).trace_id;
      expect({ header, v4: typeof traceId === 'string' && V4.test(traceId) }).toEqual({
        header,
        v4: true,
      });
      const id = String(traceId);
      expectHealthz(result, id);
      expectAccessLines(result.lines, id, '/healthz', 200);
      const everything = [result.body, JSON.stringify(result.headers), ...result.lines].join('\n');
      expect({ header, found: everything.includes(header) }).toEqual({ header, found: false });
      seen.push(id);
    }
  }
  expect(new Set(seen).size).toBe(seen.length);

  const missing = await exchange(`/${SAMPLES.cardNo}`, SAMPLES.phone);
  expect(missing.statusCode).toBe(404);
  const reqId = (parseStrict(missing.lines[0] ?? '') as { reqId?: unknown }).reqId;
  expect({
    v4: typeof reqId === 'string' && V4.test(reqId),
    fresh: !seen.includes(String(reqId)),
  }).toEqual({ v4: true, fresh: true });
  expectAccessLines(missing.lines, String(reqId), '[unmatched]', 404);
  expect([missing.body, ...missing.lines].join('\n').includes(SAMPLES.phone)).toBe(false);
}, 30_000);

it('[规划/04 §5][规划/02 §19] HTTP 入口：旧格式的示例值（trace-abc_123、validation-trace、64 个 A）与 31 位、33 位十六进制都不采用，trace_id 与 reqId 是同一个新 v4 UUID', async () => {
  for (const header of [
    'trace-abc_123',
    'validation-trace',
    'A'.repeat(64),
    HEX_LOWER.slice(1),
    `${HEX_LOWER}0`,
  ]) {
    const result = await exchange('/healthz', header);
    const traceId = String((parseStrict(result.body) as { trace_id?: unknown }).trace_id);
    expect({ header, v4: V4.test(traceId) }).toEqual({ header, v4: true });
    expectHealthz(result, traceId);
    expectAccessLines(result.lines, traceId, '/healthz', 200);
  }
}, 30_000);

it('[规划/04 §5][规划/03 §4.2] HTTP 入口：合格的 x-trace-id（小写 UUID、iOS 的大写 UUID、32 位十六进制大小写）原样作为响应 trace_id 与访问日志两行的 reqId；重复的两个合格头不采用任何一个，换成新 UUID', async () => {
  for (const header of [UUID_LOWER, UUID_UPPER, HEX_LOWER, HEX_UPPER]) {
    const result = await exchange('/healthz', header);
    expectHealthz(result, header);
    expectAccessLines(result.lines, header, '/healthz', 200);
  }
  const doubled = await exchange('/healthz', [UUID_LOWER, UUID_UPPER]);
  const traceId = String((parseStrict(doubled.body) as { trace_id?: unknown }).trace_id);
  expect({
    v4: V4.test(traceId),
    taken: [UUID_LOWER, UUID_UPPER.toLowerCase()].includes(traceId.toLowerCase()),
  }).toEqual({ v4: true, taken: false });
  expectHealthz(doubled, traceId);
  expectAccessLines(doubled.lines, traceId, '/healthz', 200);
}, 30_000);
