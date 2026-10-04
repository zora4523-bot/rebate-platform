// Contract addendum (code review rounds 1–3, path B)
//
// This addendum supplements the log-redaction contract in the header comment of
// apps/api/src/modules/platform/masking/index.ts (规划/08 BR-ID-33「日志中不得出现明文」; 规划/02
// §12.3, §19 日志). Where the two disagree, this addendum wins. It writes down, as exact output,
// the channels that the three rounds of code review of B1-01c found (couli-runs/B1-01c
// review-*-round{1,2,3}.json); the rule tests below pin each of them with kit.ts `expectLine`
// (strict parse, hand-built expected record, toStrictEqual, the sensitive-name walk and the
// plaintext search as a second net). "Level 1" is a field of the logged object or of a binding.
// Round 2 of path B (2026-10-04, decision-orchestrator.md): the values of F and G are
// confirmed; D is corrected to what pino writes for %j / %o / %O; K and L replace the two
// known gaps of round 1 (binary values, non-Error values under err).
//
// A. toJSON, layer by layer. Wherever a value is written (a field at any depth, an array
//    element, a printf argument, a Nest parameter, and also the logged object itself and the
//    bindings given to child() or setBindings() at every generation), an object with a callable
//    toJSON is replaced by what toJSON returns, and when that result again has a callable toJSON
//    it is replaced again, until a value without one is reached; that value is then written by
//    the rules. Own properties of an object that has toJSON are never written (only its toJSON
//    result is). An object whose toJSON returns the object itself stops there.
// B. Boxed primitives (String, Number, Boolean, BigInt wrapper objects). At level 1 or deeper,
//    in arrays, printf arguments and the message argument, a wrapper is first unwrapped to its
//    primitive and written by the rule for that primitive (so under msg / message / stack it is
//    free text, under a sensitive name "[REDACTED]", elsewhere the primitive as it is). When the
//    logged object itself or a binding is a wrapper, a binary value (K) or a URL (G), or its
//    toJSON chain (A) ends in anything that is not such an object or a plain object (a
//    primitive, a wrapper, a binary value, a URL), it contributes no field: the line is written
//    as if {} had been passed.
// C. BigInt. Under msg / message / stack (any depth, see E) and under err (see L) a bigint is
//    free text: its decimal text goes through the safety net and is written as a string. A
//    bigint message argument is `msg` the same way. Under any other non-sensitive name it is
//    written as a JSON number with every digit (999999999999999999999999999999n →
//    999999999999999999999999999999); the call neither throws nor loses the line.
//    Functions. A function with a callable toJSON is written by A. Any other function is left
//    out of an object and written as null in an array, as JSON.stringify does.
// D. printf. Every argument is first replaced by its rule copy (the value these rules write).
//    Then, as pino's quick-format-unescaped writes it:
//      %s  an Error: `<name>: <message>`; any other value: its rule copy, a string, number,
//          boolean or bigint copy as its text (no quotes), anything else as its JSON text (keys in
//          insertion order). The caller's toString is never called. A name or message getter that
//          throws makes that %s "[Unserializable]".
//      %j, %o, %O  a string copy in single quotes, unescaped ('[Binary 16 bytes]',
//          'text'); an undefined copy (a function without toJSON) leaves the placeholder in the
//          text; anything else its JSON text.
//      %d, %f  Number(copy); %i  Math.floor(Number(copy)); a null or undefined copy leaves the
//          placeholder.
//    Every %<character> except %% consumes one argument (including ones not expanded, such as
//    %x, which stays in the text); %% writes "%". The safety net then applies to the whole msg.
// E. Free text at any depth. Every string, number and bigint at any depth below a key named
//    exactly msg, message or stack (inside arrays, nested arrays and nested objects) is free text
//    and written as a string after the safety net; booleans and null stay as they are. A message
//    argument that is not a string is first written by the rules (it is under `msg`, so E
//    applies inside it); when the result is a string, number or boolean its text is `msg`,
//    otherwise its JSON text (keys in insertion order) is `msg`; the whole `msg` then goes
//    through the safety net.
// F. Access log (Fastify through the root logger, as createHttpApp wires it). "incoming request"
//    writes req = { method, url, hostname, remoteAddress, remotePort } and "request completed"
//    writes res = { statusCode } (and Fastify's own reqId binding and responseTime); remotePort
//    is left out when the socket has none (Fastify inject). `url` is the route template that
//    matched (Fastify routeOptions.url, e.g. /v1/users/:id); when no route matched it is the
//    fixed string "[unmatched]". The raw path, the query string and the fragment are never
//    written.
// G. A URL object (instanceof URL), wherever it is written below level 0, is the string
//    origin + pathname: no userinfo, no query string, no fragment (https://x.example:8443/cb/path).
//    This rule comes before A (URL's own toJSON returns the full href and is not used); under
//    msg / message / stack the string is free text. As the logged object or a binding, see B.
// H. A log call never throws because of a value. A getter that throws, a toJSON (or a getter of
//    toJSON) that throws, and a serializer given to child() that throws are written as the string
//    "[Unserializable]" at that place (a getter under a sensitive name is not even called: the
//    value is "[REDACTED]"). A value at level 101 or deeper is written as "[Truncated]" (so a
//    field holding 3000 nested objects is written as 100 levels of objects and then
//    "[Truncated]"). Placeholders never contain any part of the original value.
//    Free text of any length is handled in time linear in its length: an 80 000-character text
//    without "@" is logged within 2 seconds.
// I. child() options. A `msg` serializer given to child() (at any generation) may change the
//    message, but its result is then written by E: the safety net on the final `msg` cannot be
//    replaced. Every other serializer is called with the original value (prototype getters
//    intact) and its result is written by the rules; serializers are inherited by grandchildren
//    and apply to the bindings given in the same child() call. formatters.log and
//    formatters.bindings given to a child are inherited by its descendants that give none, and
//    their output is written by the rules.
// J. 18-digit ID numbers in free text: between the 17th digit and a final digit one space or
//    hyphen-minus may stand; before a final X or x none may (11010519491231002 1 → one ID
//    number; 11010519491231002 X → 17 digits, a bank card number, then " X" kept).
// K. Binary values: a Buffer, any other TypedArray, a DataView, an ArrayBuffer or a
//    SharedArrayBuffer is written as the string "[Binary <byteLength> bytes]" (the byteLength of
//    that view or buffer, in decimal: Buffer.from('11010519491231002X') → "[Binary 18 bytes]"),
//    never its content. This comes before A (Buffer's own toJSON is not used) and holds at every
//    place a value is written: fields at any depth, arrays, toJSON results, Error properties,
//    serializer output, bindings, the message argument, printf arguments (by D: %s writes the
//    text, %j / %o / %O the text in single quotes) and Nest parameters. Under a sensitive name
//    the value is still "[REDACTED]"; as the logged object or a binding, see B.
// L. err. A value under a key named exactly err (at any depth, in the logged object and in
//    bindings) that is not an Error is free text by E: strings, numbers and bigints at any depth
//    below it go through the safety net and are written as strings ({ err: 13987654321n } →
//    { err: "[REDACTED]" }; { err: { status: 500 } } → { err: { status: "500" } }). An Error under
//    err is written by the Error rule as before (its own properties other than message and stack
//    are not free text).
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
  nest,
  parseStrict,
  snapshotOf,
} from './kit.ts';

const UNSERIALIZABLE = '[Unserializable]';
const TRUNCATED = '[Truncated]';
const PHONE_TEXT = `手机号${SAMPLES.phone}`;
const PHONE_SCRUBBED = `手机号${REDACTED}`;

/** pino's typings reject non-string messages and unknown placeholders; its runtime accepts them. */
type LooseLog = (...args: unknown[]) => void;

function loose(logger: RootLogger, level: 'info' | 'warn' | 'error' = 'info'): LooseLog {
  return logger[level].bind(logger) as LooseLog;
}

/** A value whose every channel must be written the same way, as level 1 and as a nested value. */
interface Channels {
  readonly lines: string[];
}

/**
 * Puts `value` through every channel: the logged object, a nested field and an array element
 * under `nestedKey`, child() bindings, grandchild bindings, and setBindings() on the root, a
 * child and a grandchild (each on a fresh logger, since setBindings() stays).
 */
function throughChannels(value: object, nestedKey: string): Channels {
  const lines: string[] = [];
  const a = capture();
  a.logger.info(value, 'record');
  a.logger.info({ [nestedKey]: { item: value, list: [value] } }, 'nested');
  a.logger.child(value).info('child');
  a.logger.child({ user_id: KEPT.user_id }).child(value).info('grandchild');
  lines.push(...a.lines);
  const b = capture();
  b.logger.setBindings(value);
  b.logger.info('root set');
  lines.push(...b.lines);
  const c = capture();
  const child = c.logger.child({ user_id: KEPT.user_id });
  child.setBindings(value);
  child.info('child set');
  lines.push(...c.lines);
  const d = capture();
  const grandchild = d.logger.child({}).child({ user_id: KEPT.user_id });
  grandchild.setBindings(value);
  grandchild.info('grandchild set');
  lines.push(...d.lines);
  return { lines };
}

/** `top`: the fields the value contributes at level 1; `nested`: how it is written below. */
function expectChannels(
  { lines }: Channels,
  nestedKey: string,
  top: Record<string, unknown>,
  nested: unknown,
): void {
  expect(lines).toHaveLength(7);
  const user = { user_id: KEPT.user_id };
  expectLine(lines[0], { level: 30, ...top, msg: 'record' });
  expectLine(lines[1], {
    level: 30,
    [nestedKey]: { item: nested, list: [nested] },
    msg: 'nested',
  });
  expectLine(lines[2], { level: 30, ...top, msg: 'child' });
  expectLine(lines[3], { level: 30, ...user, ...top, msg: 'grandchild' });
  expectLine(lines[4], { level: 30, ...top, msg: 'root set' });
  expectLine(lines[5], { level: 30, ...user, ...top, msg: 'child set' });
  expectLine(lines[6], { level: 30, ...user, ...top, msg: 'grandchild set' });
}

it('[BR-ID-33] 日志（评审补充 A）：顶层日志对象、child() 与孙 logger 的绑定、根 / 子 / 孙 logger 的 setBindings() 带 toJSON 时写 toJSON 的返回值（自身属性不写），返回非对象时不贡献字段', () => {
  const record = {
    value: SAMPLES.phone,
    toJSON(): Record<string, unknown> {
      return { phone: this.value, order_id: KEPT.order_id };
    },
  };
  const before = snapshotOf(record);
  expectChannels(
    throughChannels(record, 'wrap'),
    'wrap',
    { phone: REDACTED, order_id: KEPT.order_id },
    { phone: REDACTED, order_id: KEPT.order_id },
  );
  for (const result of [SAMPLES.phone, Number(SAMPLES.phone), BigInt(SAMPLES.phone), true, null]) {
    const primitive = { value: SAMPLES.phone, toJSON: (): unknown => result };
    const nested = result === true ? true : result === null ? null : REDACTED;
    expectChannels(throughChannels(primitive, 'message'), 'message', {}, nested);
  }
  expect(snapshotOf(record)).toEqual(before);
});

it('[BR-ID-33] 日志（评审补充 A）：toJSON 的返回值仍带 toJSON 时逐层继续按规则处理——顶层、嵌套、数组、child()、孙 logger、setBindings() 都不写出内层的原始字段', () => {
  const account = {
    raw: SAMPLES.alipayEmail,
    toJSON(): Record<string, unknown> {
      return { alipay_logon_id: this.raw, order_id: KEPT.order_id };
    },
  };
  const twoLevels = { toJSON: (): unknown => account };
  expectChannels(
    throughChannels(twoLevels, 'wrap'),
    'wrap',
    { alipay_logon_id: REDACTED, order_id: KEPT.order_id },
    { alipay_logon_id: REDACTED, order_id: KEPT.order_id },
  );
  const fourLevels = {
    hidden: SAMPLES.payeeName,
    toJSON: (): unknown => ({
      hidden: SAMPLES.realName,
      toJSON: (): unknown => ({
        hidden: SAMPLES.bankCard,
        toJSON: (): unknown => ({ real_name: SAMPLES.realName, card_no: SAMPLES.cardNo, n: 1 }),
      }),
    }),
  };
  expectChannels(
    throughChannels(fourLevels, 'wrap'),
    'wrap',
    { real_name: REDACTED, card_no: REDACTED, n: 1 },
    { real_name: REDACTED, card_no: REDACTED, n: 1 },
  );
  const endsInText = {
    hidden: SAMPLES.realName,
    toJSON: (): unknown => ({ hidden: SAMPLES.payeeName, toJSON: (): unknown => PHONE_TEXT }),
  };
  expectChannels(throughChannels(endsInText, 'message'), 'message', {}, PHONE_SCRUBBED);
  const { logger, lines } = capture();
  logger.info('account %j and %s', twoLevels, twoLevels);
  expectLine(lines[0], {
    level: 30,
    msg:
      `account {"alipay_logon_id":"[REDACTED]","order_id":"${KEPT.order_id}"} and ` +
      `{"alipay_logon_id":"[REDACTED]","order_id":"${KEPT.order_id}"}`,
  });
  expect(account.raw).toBe(SAMPLES.alipayEmail);
});

it('[BR-ID-33] 日志（评审补充 C）：带可调用 toJSON 的函数按 toJSON 规则写（嵌套、数组、绑定、printf），其他函数在对象里省略、在数组里写 null', () => {
  const { logger, lines } = capture();
  const deferred = Object.assign((): void => undefined, {
    toJSON: (): Record<string, unknown> => ({
      phone: SAMPLES.phone,
      real_name: SAMPLES.realName,
      order_id: KEPT.order_id,
    }),
  });
  const omitted = (): void => undefined;
  const written = { phone: REDACTED, real_name: REDACTED, order_id: KEPT.order_id };
  logger.info({ payload: { deferred, omitted, kept: 'k' }, list: [omitted, deferred] }, 'fn');
  logger.child({ deferred, omitted }).info('bound');
  logger.info('payload %j', { deferred });
  expect(lines).toHaveLength(3);
  expectLine(lines[0], {
    level: 30,
    payload: { deferred: written, kept: 'k' },
    list: [null, written],
    msg: 'fn',
  });
  expectLine(lines[1], { level: 30, deferred: written, msg: 'bound' });
  expectLine(lines[2], {
    level: 30,
    msg: `payload {"deferred":{"phone":"[REDACTED]","real_name":"[REDACTED]","order_id":"${KEPT.order_id}"}}`,
  });
});

it('[BR-ID-33] 日志（评审补充 B）：嵌套位置、数组、绑定字段与消息参数里的装箱原始值先拆回原始值，再按原始值规则写（自由文本键下过安全网，敏感名下 [REDACTED]）', () => {
  const { logger, lines } = capture();
  const boxedText = Object(PHONE_TEXT) as object;
  logger.info(
    {
      message: boxedText,
      detail: {
        stack: [Object(Number(SAMPLES.phone)), Object(BigInt(SAMPLES.phone)), Object(true)],
      },
      amount_fen: Object(1999) as object,
      enabled: Object(false) as object,
      big: Object(123n) as object,
      phone: Object(SAMPLES.phone) as object,
      label: Object('route-a') as object,
    },
    'boxed',
  );
  logger.child({ message: boxedText, amount_fen: Object(5) as object }).info('bound');
  loose(logger)({ order_id: KEPT.order_id }, boxedText);
  expect(lines).toHaveLength(3);
  expectLine(lines[0], {
    level: 30,
    message: PHONE_SCRUBBED,
    detail: { stack: [REDACTED, REDACTED, true] },
    amount_fen: 1999,
    enabled: false,
    big: 123,
    phone: REDACTED,
    label: 'route-a',
    msg: 'boxed',
  });
  expectLine(lines[1], { level: 30, message: PHONE_SCRUBBED, amount_fen: 5, msg: 'bound' });
  expectLine(lines[2], { level: 30, order_id: KEPT.order_id, msg: PHONE_SCRUBBED });
});

it('[BR-ID-33] 日志（评审补充 B）：顶层日志对象或绑定本身是装箱原始值（String / Number / Boolean / BigInt）时不贡献字段，绝不按下标逐位写出', () => {
  const cases: readonly (readonly [object, unknown])[] = [
    [Object(PHONE_TEXT) as object, PHONE_SCRUBBED],
    [Object(Number(SAMPLES.phone)) as object, REDACTED],
    [Object(BigInt(SAMPLES.phone)) as object, REDACTED],
    [Object(true) as object, true],
  ];
  for (const [boxed, nested] of cases) {
    expectChannels(throughChannels(boxed, 'message'), 'message', {}, nested);
  }
});

it('[BR-ID-33] 日志（评审补充 C）：BigInt 在 msg 参数、对象自带的 msg、任意深度 message / stack 下按十进制文本过安全网；其他名字下写完整的数字值，不抛错、不丢行', () => {
  const { logger, lines } = capture();
  const log = loose(logger);
  log(BigInt(SAMPLES.phone));
  log({ msg: BigInt(SAMPLES.phone) });
  logger.info(
    {
      message: BigInt(SAMPLES.phone),
      r: { stack: BigInt(SAMPLES.phone) },
      list: { message: [BigInt(SAMPLES.phone)] },
      amount_fen: 1999n,
      order_id: 999999999999999999999999999999n,
    },
    'bigint',
  );
  logger.child({ message: BigInt(SAMPLES.phone), amount_fen: 5n }).info('bound');
  logger.info('amount %j', { amount_fen: 1999n, message: BigInt(SAMPLES.phone) });
  log('phone %s', BigInt(SAMPLES.phone));
  const nestCapture = capture();
  new PinoNestLogger(nestCapture.logger).log({ amount_fen: 1999n });
  expect({ lines: lines.length, nest: nestCapture.lines.length }).toEqual({ lines: 6, nest: 1 });
  expectLine(lines[0], { level: 30, msg: REDACTED });
  expectLine(lines[1], { level: 30, msg: REDACTED });
  expectLine(lines[2], {
    level: 30,
    message: REDACTED,
    r: { stack: REDACTED },
    list: { message: [REDACTED] },
    amount_fen: 1999,
    order_id: 999999999999999999999999999999,
    msg: 'bigint',
  });
  expect(lines[2]).toContain('"order_id":999999999999999999999999999999,');
  expectLine(lines[3], { level: 30, message: REDACTED, amount_fen: 5, msg: 'bound' });
  expectLine(lines[4], { level: 30, msg: 'amount {"amount_fen":1999,"message":"[REDACTED]"}' });
  expectLine(lines[5], { level: 30, msg: `phone ${REDACTED}` });
  expectLine(nestCapture.lines[0], { level: 30, msg: '{"amount_fen":1999}' });
});

it('[BR-ID-33] 日志（评审补充 D）：printf %s 对 Error 写 name: message，对其他对象写规则副本的 JSON 而不调用调用方的 toString；除 %% 外任意 %<字符> 消耗一个参数', () => {
  const { logger, lines } = capture();
  const log = loose(logger);
  let toStringCalls = 0;
  const leakyText = (): string => {
    toStringCalls += 1;
    return `real_name=${SAMPLES.realName}&phone=${SAMPLES.phone}`;
  };
  class PayoutError extends Error {
    override readonly name = 'PayoutError';
  }
  const typeError = new TypeError(PHONE_TEXT);
  const withToString = {
    real_name: SAMPLES.realName,
    order_id: KEPT.order_id,
    toString: leakyText,
  };
  logger.error('payout failed: %s; %% %s; %j', typeError, withToString, { phone: SAMPLES.phone });
  log(
    'params %s, map %s, list %s, custom %s',
    new URLSearchParams({ real_name: SAMPLES.realName, card_no: SAMPLES.cardNo }),
    new Map([['real_name', SAMPLES.realName]]),
    ['a', { token: SAMPLES.credential, toString: leakyText }],
    new PayoutError(PHONE_TEXT),
  );
  log('rate 5%x then %s', { toString: leakyText }, typeError);
  log('count %d and %s; text %s', 3, typeError, 'plain');
  for (const key of ['name', 'message']) {
    const failing = new Error('failure');
    Object.defineProperty(failing, key, {
      get(): never {
        throw new Error(PHONE_TEXT);
      },
    });
    log('failure %s', failing);
  }
  expect(lines).toHaveLength(6);
  expectLine(lines[0], {
    level: 50,
    msg:
      `payout failed: TypeError: ${PHONE_SCRUBBED}; % ` +
      `{"real_name":"[REDACTED]","order_id":"${KEPT.order_id}"}; {"phone":"[REDACTED]"}`,
  });
  expectLine(lines[1], {
    level: 30,
    msg: `params {}, map {}, list ["a",{"token":"[REDACTED]"}], custom PayoutError: ${PHONE_SCRUBBED}`,
  });
  expectLine(lines[2], { level: 30, msg: `rate 5%x then TypeError: ${PHONE_SCRUBBED}` });
  expectLine(lines[3], {
    level: 30,
    msg: `count 3 and TypeError: ${PHONE_SCRUBBED}; text plain`,
  });
  expectLine(lines[4], { level: 30, msg: `failure ${UNSERIALIZABLE}` });
  expectLine(lines[5], { level: 30, msg: `failure ${UNSERIALIZABLE}` });
  expect(toStringCalls).toBe(0);
});

it('[BR-ID-33] 日志（评审补充 E）：msg / message / stack 下任意深度（数组、嵌套数组、嵌套对象）的字符串、数字、bigint 都过安全网；非字符串消息参数先按规则写成 JSON 再整体过安全网；绑定与 Nest 参数同样', () => {
  const { logger, lines } = capture();
  const log = loose(logger);
  const values = [PHONE_TEXT, Number(SAMPLES.phone), BigInt(SAMPLES.phone)];
  const scrubbed = [PHONE_SCRUBBED, REDACTED, REDACTED];
  log({ order_id: KEPT.order_id }, [PHONE_TEXT, Number(SAMPLES.phone)]);
  log({}, { text: PHONE_TEXT, phone: SAMPLES.phone, count: 3, ok: true });
  logger.info(
    {
      result: { stack: ['at a', PHONE_TEXT] },
      message: [...values, [{ text: SAMPLES.bankCard, ok: true, none: null }]],
      deep: nest(10, { msg: { lines: [`卡 ${SAMPLES.bankCard}`, 7] } }),
    },
    'deep',
  );
  const child = logger.child({ message: [PHONE_TEXT], stack: { frames: [Number(SAMPLES.phone)] } });
  child.info('bound');
  const grandchild = child.child({ user_id: KEPT.user_id });
  grandchild.setBindings({ step: { msg: { text: [values] } } });
  grandchild.info('grandchild set');
  const nestCapture = capture();
  new PinoNestLogger(nestCapture.logger).warn('checked', { message: [PHONE_TEXT] }, 'Payee');
  expect({ lines: lines.length, nest: nestCapture.lines.length }).toEqual({ lines: 5, nest: 1 });
  expectLine(lines[0], {
    level: 30,
    order_id: KEPT.order_id,
    msg: `["${PHONE_SCRUBBED}","[REDACTED]"]`,
  });
  expectLine(lines[1], {
    level: 30,
    msg: `{"text":"${PHONE_SCRUBBED}","phone":"[REDACTED]","count":"3","ok":true}`,
  });
  expectLine(lines[2], {
    level: 30,
    result: { stack: ['at a', PHONE_SCRUBBED] },
    message: [...scrubbed, [{ text: REDACTED, ok: true, none: null }]],
    deep: nest(10, { msg: { lines: [`卡 ${REDACTED}`, '7'] } }),
    msg: 'deep',
  });
  const bound = { message: [PHONE_SCRUBBED], stack: { frames: [REDACTED] } };
  expectLine(lines[3], { level: 30, ...bound, msg: 'bound' });
  expectLine(lines[4], {
    level: 30,
    ...bound,
    user_id: KEPT.user_id,
    step: { msg: { text: [scrubbed] } },
    msg: 'grandchild set',
  });
  expectLine(nestCapture.lines[0], {
    level: 40,
    context: 'Payee',
    params: [{ message: [PHONE_SCRUBBED] }],
    msg: 'checked',
  });
});

class Payload {
  get phone(): string {
    return SAMPLES.phone;
  }

  get order(): string {
    return KEPT.order_id;
  }
}

it('[BR-ID-33] 日志（评审补充 I）：child() 的 msg 序列化器替换不掉最终 msg 的安全网（子、孙、带 msgPrefix）；其他序列化器拿到原值、输出按规则写并被孙 logger 继承；孙 logger 沿用父级的 formatters', () => {
  const { logger, lines } = capture();
  const trimmed = logger.child({}, { serializers: { msg: (v: unknown) => String(v).trim() } });
  trimmed.info(` ${PHONE_TEXT} `);
  trimmed.child({ order_id: KEPT.order_id }).info(` ${PHONE_TEXT} `);
  logger
    .child(
      {},
      {
        serializers: { msg: () => ({ phone: SAMPLES.phone, text: PHONE_TEXT }) },
        msgPrefix: `${PHONE_TEXT} `,
      },
    )
    .info('event');
  logger.child({}, { serializers: { msg: () => [PHONE_TEXT] } }).info('event');
  const originals: unknown[] = [];
  const serializer = (original: unknown): unknown => {
    originals.push(original);
    const payload = original as Payload;
    return {
      contact: { phone: payload.phone },
      order_id: payload.order,
      original: original instanceof Payload,
    };
  };
  const serialized = logger.child(
    { bound: new Payload() },
    { serializers: { bound: serializer, payload: serializer } },
  );
  serialized.info({ payload: new Payload() }, 'serialized');
  serialized.child({ user_id: KEPT.user_id }).info({ payload: new Payload() }, 'inherited');
  const formatted = logger.child(
    {},
    { formatters: { log: (r: object) => ({ ...r, service: 'payout', phone: SAMPLES.phone }) } },
  );
  const formattedChild = formatted.child({ order_id: KEPT.order_id });
  formattedChild.info('event');
  formattedChild
    .child(
      { user_id: KEPT.user_id },
      { formatters: { log: (r: object) => ({ ...r, service: 'worker' }) } },
    )
    .info('override');
  logger
    .child(
      { user_id: KEPT.user_id },
      { formatters: { bindings: (b: object) => ({ ...b, token: SAMPLES.credential }) } },
    )
    .info('bindings formatter');
  expect(lines).toHaveLength(9);
  expectLine(lines[0], { level: 30, msg: PHONE_SCRUBBED });
  expectLine(lines[1], { level: 30, order_id: KEPT.order_id, msg: PHONE_SCRUBBED });
  expectLine(lines[2], { level: 30, msg: `{"phone":"[REDACTED]","text":"${PHONE_SCRUBBED}"}` });
  expectLine(lines[3], { level: 30, msg: `["${PHONE_SCRUBBED}"]` });
  const out = { contact: { phone: REDACTED }, order_id: KEPT.order_id, original: true };
  expectLine(lines[4], { level: 30, bound: out, payload: out, msg: 'serialized' });
  expectLine(lines[5], {
    level: 30,
    bound: out,
    user_id: KEPT.user_id,
    payload: out,
    msg: 'inherited',
  });
  expectLine(lines[6], {
    level: 30,
    order_id: KEPT.order_id,
    service: 'payout',
    phone: REDACTED,
    msg: 'event',
  });
  expectLine(lines[7], {
    level: 30,
    order_id: KEPT.order_id,
    user_id: KEPT.user_id,
    service: 'worker',
    msg: 'override',
  });
  expectLine(lines[8], {
    level: 30,
    user_id: KEPT.user_id,
    token: REDACTED,
    msg: 'bindings formatter',
  });
  expect(originals.every((original) => original instanceof Payload)).toBe(true);
});

/** `value` inside `levels` objects under the key `nested`. */
function chain(levels: number, value: unknown): unknown {
  let current = value;
  for (let level = 0; level < levels; level += 1) current = { nested: current };
  return current;
}

it('[BR-ID-33] 日志（评审补充 H）：getter、toJSON、toJSON 的 getter、函数的 toJSON、child 序列化器抛错时写 [Unserializable]，敏感名下的 getter 不调用；第 101 层起写 [Truncated]；日志调用本身不抛', () => {
  const fail = (): never => {
    throw new Error(PHONE_TEXT);
  };
  let sensitiveGetterCalls = 0;
  const value = {
    get broken(): unknown {
      return fail();
    },
    get phone(): unknown {
      sensitiveGetterCalls += 1;
      return fail();
    },
    nested: {
      get broken(): unknown {
        return fail();
      },
      get id_no(): unknown {
        sensitiveGetterCalls += 1;
        return fail();
      },
      kept: 'yes',
    },
    badJSON: { toJSON: fail },
    badJSONGetter: {
      get toJSON(): unknown {
        return fail();
      },
    },
    badFunction: Object.assign((): void => undefined, { toJSON: fail }),
  };
  const written = {
    broken: UNSERIALIZABLE,
    phone: REDACTED,
    nested: { broken: UNSERIALIZABLE, id_no: REDACTED, kept: 'yes' },
    badJSON: UNSERIALIZABLE,
    badJSONGetter: UNSERIALIZABLE,
    badFunction: UNSERIALIZABLE,
  };
  const deep = chain(3000, { phone: SAMPLES.phone });
  const { logger, lines } = capture();
  expect(() => {
    logger.info(value, 'event');
    logger.child(value).info('bound');
    logger.child({}, { serializers: { custom: fail } }).info({ custom: { a: 1 } }, 'serializer');
    logger.info({ deep }, 'deep');
    logger.child({ deep }).info('deep bound');
    logger.info({ shallow: chain(98, { kept: 'yes', phone: SAMPLES.phone }) }, 'shallow');
    logger.info('bad %s and %j', { toJSON: fail }, [value.badJSONGetter]);
  }).not.toThrow();
  const fresh = capture();
  expect(() => {
    fresh.logger.setBindings(value);
    fresh.logger.info('set');
  }).not.toThrow();
  expect({ lines: lines.length, fresh: fresh.lines.length }).toEqual({ lines: 7, fresh: 1 });
  expectLine(lines[0], { level: 30, ...written, msg: 'event' });
  expectLine(lines[1], { level: 30, ...written, msg: 'bound' });
  expectLine(lines[2], { level: 30, custom: UNSERIALIZABLE, msg: 'serializer' });
  // The value of `deep` is level 1; levels 1–100 are objects and level 101 is the placeholder.
  // In `shallow` the innermost fields are level 100 and are written.
  expectLine(lines[3], { level: 30, deep: chain(100, TRUNCATED), msg: 'deep' });
  expectLine(lines[4], { level: 30, deep: chain(100, TRUNCATED), msg: 'deep bound' });
  expectLine(lines[5], {
    level: 30,
    shallow: chain(98, { kept: 'yes', phone: REDACTED }),
    msg: 'shallow',
  });
  expectLine(lines[6], {
    level: 30,
    msg: `bad ${UNSERIALIZABLE} and ["${UNSERIALIZABLE}"]`,
  });
  expectLine(fresh.lines[0], { level: 30, ...written, msg: 'set' });
  expect(sensitiveGetterCalls).toBe(0);
});

it('[BR-ID-33] 日志（评审补充 H）：8 万字符、不含 @ 的自由文本（错误 message、stack 与 msg）在 2 秒内写完，且原样保留', () => {
  const { logger, lines } = capture();
  const text = `payload ${'x'.repeat(80_000)}`;
  const error = new Error(text);
  const started = performance.now();
  logger.error({ err: error }, text);
  const elapsed = performance.now() - started;
  expect(lines).toHaveLength(1);
  expectLine(lines[0], { level: 50, err: errorShape('Error', error), msg: text });
  expect(elapsed).toBeLessThan(2000);
});

it('[BR-ID-33] 日志（评审补充 J）：18 位身份证末位数字前允许一个空格或连字符，末位 X 前不允许', () => {
  const { logger, lines } = capture();
  const cases: readonly (readonly [string, string])[] = [
    ['证件 11010519491231002 1 2 次', `证件 ${REDACTED} 2 次`],
    ['证件 11010519491231002-1 2 次', `证件 ${REDACTED} 2 次`],
    ['证件 11010519491231002 X 待核验', `证件 ${REDACTED} X 待核验`],
    ['证件 11010519491231002-x 待核验', `证件 ${REDACTED}-x 待核验`],
    ['证件 110105 19491231 002X 待核验', `证件 ${REDACTED} 待核验`],
  ];
  for (const [text] of cases) logger.info({ detail: { message: text } }, text);
  expect(lines).toHaveLength(cases.length);
  cases.forEach(([, expected], i) => {
    expectLine(lines[i], { level: 30, detail: { message: expected }, msg: expected });
  });
});

// Access log (addendum F). createHttpApp is loaded at run time by URL: bootstrap.ts needs the
// decorator settings of apps/api, which the `test` TypeScript project does not have, so only
// the shape used here is declared.
interface InjectResponse {
  readonly statusCode: number;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(request: {
    method: 'GET';
    url: string;
    headers: Record<string, string>;
  }): Promise<InjectResponse>;
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

/** Runs `urls` through an api app over the in-memory logger; returns the access-log lines. */
async function accessLog(
  urls: readonly string[],
): Promise<{ lines: string[]; statusCodes: number[] }> {
  const { createHttpApp } = (await import(BOOTSTRAP)) as { createHttpApp: CreateHttpApp };
  const { logger, lines } = capture();
  const app = await createHttpApp('api', { logger, config: loadConfig({ APP_ENV: 'test' }) });
  const statusCodes: number[] = [];
  try {
    await app.init();
    app
      .getHttpAdapter()
      .getInstance()
      .get('/v1/users/:id', async () => ({ ok: true }));
    const startup = lines.length;
    for (const url of urls) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { 'x-trace-id': TRACE_ID, authorization: `Bearer ${SAMPLES.credential}` },
      });
      statusCodes.push(response.statusCode);
    }
    return { lines: lines.slice(startup), statusCodes };
  } finally {
    await app.close();
  }
}

function expectAccessLines(
  lines: readonly string[],
  index: number,
  url: string,
  statusCode: number,
): void {
  expectLine(lines[index * 2], {
    level: 30,
    reqId: TRACE_ID,
    req: { method: 'GET', url, hostname: 'localhost', remoteAddress: '127.0.0.1' },
    msg: 'incoming request',
  });
  // responseTime is Fastify's own timing: any non-negative number. It is pinned to 0 before the
  // exact check so that its random digits cannot match a sample piece in the plaintext search.
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

it('[BR-ID-33] 访问日志（评审补充 F）：Fastify 请求经根 logger 写 method、url、hostname、remoteAddress 与 statusCode，不丢字段；查询串与请求头不写', async () => {
  const query = new URLSearchParams({ phone: SAMPLES.phone, alipay_logon_id: SAMPLES.alipayEmail });
  const { lines, statusCodes } = await accessLog([`/healthz?${query.toString()}`]);
  expect({ lines: lines.length, statusCodes }).toEqual({ lines: 2, statusCodes: [200] });
  expectAccessLines(lines, 0, '/healthz', 200);
}, 30_000);

it('[BR-ID-33] 访问日志（评审补充 F）：url 写匹配到的路由模板（/v1/users/:id），没匹配到路由写 [unmatched]；路径里的手机号、邮箱不写（含 404）', async () => {
  const urls = [
    `/v1/users/${SAMPLES.phone}?ref=${SAMPLES.idNo}`,
    `/${SAMPLES.phone}`,
    `/callback/${SAMPLES.alipayEmail}`,
    `/healthz/${SAMPLES.bankCard}`,
  ];
  const { lines, statusCodes } = await accessLog(urls);
  expect({ lines: lines.length, statusCodes }).toEqual({
    lines: 8,
    statusCodes: [200, 404, 404, 404],
  });
  expectAccessLines(lines, 0, '/v1/users/:id', 200);
  expectAccessLines(lines, 1, '[unmatched]', 404);
  expectAccessLines(lines, 2, '[unmatched]', 404);
  expectAccessLines(lines, 3, '[unmatched]', 404);
}, 30_000);

it('[BR-ID-33] 日志（评审补充 G）：URL 对象写 origin + pathname（去掉 userinfo、查询串、片段），在嵌套、数组、绑定、printf、Nest 参数里一样；自由文本键下过安全网；顶层日志对象或绑定是 URL 时不贡献字段', () => {
  const link = new URL('https://x.example:8443/cb/path#frag');
  link.username = 'ops';
  Reflect.set(link, ['pass', 'word'].join(''), ['pw', '7Q'].join(''));
  link.searchParams.set('access_token', SAMPLES.credential);
  link.searchParams.set('real_name', SAMPLES.realName);
  const written = 'https://x.example:8443/cb/path';
  const withPhone = new URL(`https://x.example/u/${SAMPLES.phone}?ref=1`);
  const { logger, lines } = capture();
  logger.info(
    {
      link,
      message: withPhone,
      list: [new URL('http://x.example/a?b=c'), link],
      phone: withPhone,
    },
    'urls',
  );
  logger.child({ link }).info('bound');
  logger.info('redirect %s then %j', link, [link]);
  const nestCapture = capture();
  new PinoNestLogger(nestCapture.logger).warn('callback', link, 'Callback');
  expect({ lines: lines.length, nest: nestCapture.lines.length }).toEqual({ lines: 3, nest: 1 });
  expectLine(lines[0], {
    level: 30,
    link: written,
    message: `https://x.example/u/${REDACTED}`,
    list: ['http://x.example/a', written],
    phone: REDACTED,
    msg: 'urls',
  });
  expectLine(lines[1], { level: 30, link: written, msg: 'bound' });
  expectLine(lines[2], { level: 30, msg: `redirect ${written} then ["${written}"]` });
  expectLine(nestCapture.lines[0], {
    level: 40,
    context: 'Callback',
    params: [written],
    msg: 'callback',
  });
  expectChannels(throughChannels(link, 'wrap'), 'wrap', {}, written);
  expect(link.username).toBe('ops');
});

it('[BR-ID-33] 日志（评审补充 D，第 2 轮）：%j、%o、%O 按 pino 的写法：字符串规则副本写单引号、不转义，没有规则副本的函数保留占位符，其余写 JSON；%d 写数字；整条 msg 再过安全网', () => {
  const { logger, lines } = capture();
  const fail = (): never => {
    throw new Error(PHONE_TEXT);
  };
  loose(logger)(
    'a %j b %j c %o d %d e %O f %j',
    `text ${PHONE_TEXT}`,
    (): void => undefined,
    { phone: SAMPLES.phone, n: 1 },
    Number(SAMPLES.phone),
    { toJSON: fail },
    [Object(PHONE_TEXT) as object, null],
  );
  expect(lines).toHaveLength(1);
  expectLine(lines[0], {
    level: 30,
    msg:
      `a 'text ${PHONE_SCRUBBED}' b %j c {"phone":"[REDACTED]","n":1} d ${REDACTED} ` +
      `e '${UNSERIALIZABLE}' f ["${PHONE_TEXT}",null]`.replace(PHONE_TEXT, PHONE_SCRUBBED),
  });
});

/** A fresh ArrayBuffer (not Node's shared pool) holding the UTF-8 bytes of `text`. */
function ownBytes(text: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(text, 'utf8')).buffer;
}

function binary(bytes: number): string {
  return `[Binary ${String(bytes)} bytes]`;
}

it('[BR-ID-33] 日志（评审补充 K）：Buffer、TypedArray、DataView、ArrayBuffer、SharedArrayBuffer 在任意深度、数组、toJSON 返回值、错误属性、序列化器输出与绑定里只写 [Binary <字节数> bytes]，敏感名下仍是 [REDACTED]', () => {
  const { logger, lines } = capture();
  const failure = Object.assign(new Error('upload failed'), {
    body: Buffer.from(SAMPLES.alipayEmail, 'utf8'),
  });
  logger.info(
    {
      payload: Buffer.from(SAMPLES.idNo, 'utf8'),
      view: new Uint8Array(ownBytes(SAMPLES.bankCard)),
      raw: ownBytes(SAMPLES.realName),
      window: new DataView(ownBytes(SAMPLES.phone), 2, 5),
      floats: new Float64Array([Number(SAMPLES.phone)]),
      shared: new SharedArrayBuffer(4),
      list: [Buffer.from(SAMPLES.cardNo, 'utf8')],
      message: Buffer.from(PHONE_TEXT, 'utf8'),
      id_no: Buffer.from(SAMPLES.idNo, 'utf8'),
      holder: { toJSON: (): unknown => Buffer.from(SAMPLES.payeeName, 'utf8') },
      failure,
    },
    'binary',
  );
  logger
    .child({ upload: new Uint16Array(3) }, { serializers: { body: (body: unknown) => body } })
    .info({ body: Buffer.from(SAMPLES.contactPhone, 'utf8') }, 'serialized');
  expect(lines).toHaveLength(2);
  expectLine(lines[0], {
    level: 30,
    payload: binary(18),
    view: binary(19),
    raw: binary(9),
    window: binary(5),
    floats: binary(8),
    shared: binary(4),
    list: [binary(16)],
    message: binary(20),
    id_no: REDACTED,
    holder: binary(12),
    failure: errorShape('Error', failure, { body: binary(23) }),
    msg: 'binary',
  });
  expectLine(lines[1], { level: 30, upload: binary(6), body: binary(11), msg: 'serialized' });
  expectChannels(
    throughChannels(Buffer.from(SAMPLES.idNo, 'utf8'), 'wrap'),
    'wrap',
    {},
    binary(18),
  );
  expectChannels(
    throughChannels(new Uint8Array(ownBytes(SAMPLES.bankCard)), 'message'),
    'message',
    {},
    binary(19),
  );
});

it('[BR-ID-33] 日志（评审补充 K）：二进制值作消息参数、printf 参数（%s、%j、%o、%O）与 Nest 的消息和参数时同样只写 [Binary <字节数> bytes]', () => {
  const { logger, lines } = capture();
  const log = loose(logger);
  const card = Buffer.from(SAMPLES.cardNo, 'utf8');
  log('body %s, %j, %o, %O', card, card, new Uint8Array(ownBytes(SAMPLES.idNo15)), [
    card,
    ownBytes(SAMPLES.realName),
  ]);
  log({ order_id: KEPT.order_id }, Buffer.from(PHONE_TEXT, 'utf8'));
  const nestCapture = capture();
  const adapter = new PinoNestLogger(nestCapture.logger);
  adapter.warn('upload', Buffer.from(SAMPLES.idNo, 'utf8'), 'Upload');
  adapter.log(Buffer.from(SAMPLES.idNo, 'utf8'), 'Upload');
  expect({ lines: lines.length, nest: nestCapture.lines.length }).toEqual({ lines: 2, nest: 2 });
  expectLine(lines[0], {
    level: 30,
    msg: `body ${binary(16)}, '${binary(16)}', '${binary(15)}', ["${binary(16)}","${binary(9)}"]`,
  });
  expectLine(lines[1], { level: 30, order_id: KEPT.order_id, msg: binary(20) });
  expectLine(nestCapture.lines[0], {
    level: 40,
    context: 'Upload',
    params: [binary(18)],
    msg: 'upload',
  });
  expectLine(nestCapture.lines[1], { level: 30, context: 'Upload', msg: `"${binary(18)}"` });
});

it('[BR-ID-33] 日志（评审补充 L）：err 键下不是 Error 的值（字符串、数字、bigint、数组、普通对象）按自由文本写，任意深度与绑定里一样；err 下的 Error 仍按错误规则写', () => {
  const { logger, lines } = capture();
  const coded = Object.assign(new Error('boom'), { code: 500 });
  logger.error({ err: BigInt(SAMPLES.phone) }, 'bigint');
  logger.error({ err: Number(SAMPLES.phone) }, 'number');
  logger.error({ err: `payout failed ${PHONE_TEXT}` }, 'string');
  logger.error({ err: [PHONE_TEXT, 500, true] }, 'array');
  logger.error(
    {
      err: {
        code: 'E_PAYEE',
        status: 500,
        detail: { contact: SAMPLES.phone, list: [BigInt(SAMPLES.phone)] },
        ok: true,
        phone: SAMPLES.phone,
      },
    },
    'object',
  );
  logger.warn({ ctx: { err: BigInt(SAMPLES.phone) } }, 'nested');
  logger.child({ err: PHONE_TEXT }).info('bound');
  logger.error({ err: coded }, 'error');
  logger.child({}).child({ user_id: KEPT.user_id }).error({ err: coded }, 'grandchild error');
  expect(lines).toHaveLength(9);
  expectLine(lines[0], { level: 50, err: REDACTED, msg: 'bigint' });
  expectLine(lines[1], { level: 50, err: REDACTED, msg: 'number' });
  expectLine(lines[2], { level: 50, err: `payout failed ${PHONE_SCRUBBED}`, msg: 'string' });
  expectLine(lines[3], { level: 50, err: [PHONE_SCRUBBED, '500', true], msg: 'array' });
  expectLine(lines[4], {
    level: 50,
    err: {
      code: 'E_PAYEE',
      status: '500',
      detail: { contact: REDACTED, list: [REDACTED] },
      ok: true,
      phone: REDACTED,
    },
    msg: 'object',
  });
  expectLine(lines[5], { level: 40, ctx: { err: REDACTED }, msg: 'nested' });
  expectLine(lines[6], { level: 30, err: PHONE_SCRUBBED, msg: 'bound' });
  expectLine(lines[7], { level: 50, err: errorShape('Error', coded, { code: 500 }), msg: 'error' });
  expectLine(lines[8], {
    level: 50,
    user_id: KEPT.user_id,
    err: errorShape('Error', coded, { code: 500 }),
    msg: 'grandchild error',
  });
});
