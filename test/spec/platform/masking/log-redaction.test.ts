// Rule tests for 规划/08 BR-ID-33「日志中不得出现明文」through the real root logger and the Nest
// adapter of apps/api/src/modules/platform/logging. The contract (sensitive names, the one
// replacement "[REDACTED]", how every kind of value is written) is in
// apps/api/src/modules/platform/masking/index.ts. Every line is checked by kit.ts `expectLine`:
// strict parse (no key twice), deep equality with a hand-built expected record, an independent
// walk over sensitive names, and the plaintext search as a second net. Top-level it() only
// (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  KEPT,
  REDACTED,
  SAMPLES,
  capture,
  captureNest,
  errorShape,
  errorWithPersonalData,
  expectLine,
  leaksIn,
  nest,
  parseStrict,
  redactedErrorProps,
  redactedFields,
  respell,
  sampleNames,
  sensitiveFields,
  snapshotOf,
  unredacted,
} from './kit.ts';

it('[BR-ID-33] 日志：顶层的手机号、身份证号、姓名、收款账号与凭据字段只写 [REDACTED]，其他字段与 msg 原样保留', () => {
  const { logger, lines } = capture();
  logger.info({ ...sensitiveFields(), ...KEPT }, 'payout requested');
  expect(lines).toHaveLength(1);
  expectLine(lines[0], { level: 30, ...redactedFields(), ...KEPT, msg: 'payout requested' });
  // The checks themselves: a key written twice is refused, a partial mask under a sensitive name
  // is found by the walk, and every sample written in clear is found by the second net.
  expect(() => parseStrict('{"a":{"phone":"[REDACTED]","phone":"1398***4321"}}')).toThrow(
    /duplicate key "phone"/,
  );
  expect(unredacted(parseStrict('{"user":{"phoneNumber":"139-8***-4321","name":"x"}}'))).toEqual([
    '$.user.phoneNumber',
  ]);
  expect(leaksIn(JSON.stringify({ level: 30, ...sensitiveFields() }))).toEqual(sampleNames());
});

class PayeeRecord {
  readonly bank_card_no = SAMPLES.bankCard;
  readonly payee_name = SAMPLES.payeeName;
  readonly payout_method = 'bank_card';
}

it('[BR-ID-33] 日志：任意深度（第 2、3、6、12 层）、数组、无原型对象与类实例里的敏感字段都只写 [REDACTED]，调用方的对象不被改动', () => {
  const { logger, lines } = capture();
  const deep = {
    d2: sensitiveFields(),
    d3: nest(1, sensitiveFields()),
    d6: nest(4, sensitiveFields()),
    d12: nest(10, sensitiveFields()),
    list: [sensitiveFields(), [sensitiveFields(), { more: [sensitiveFields()] }]],
    bare: Object.assign(Object.create(null) as Record<string, unknown>, sensitiveFields()),
    instance: new PayeeRecord(),
    ...KEPT,
  };
  const before = JSON.stringify(deep);
  logger.warn(deep, 'deep');
  const r = redactedFields();
  expect(lines).toHaveLength(1);
  expectLine(lines[0], {
    level: 40,
    d2: r,
    d3: nest(1, r),
    d6: nest(4, r),
    d12: nest(10, r),
    list: [r, [r, { more: [r] }]],
    bare: r,
    instance: { bank_card_no: REDACTED, payee_name: REDACTED, payout_method: 'bank_card' },
    ...KEPT,
    msg: 'deep',
  });
  expect(JSON.stringify(deep)).toBe(before);
});

it('[BR-ID-33] 日志：键名不分大小写与分隔符（bankCardNo、BANK_CARD_NO、bank-card-no 与 bank_card_no 同样替换）', () => {
  const { logger, lines } = capture();
  const styles = ['camel', 'upper', 'kebab'] as const;
  const keys = Object.keys(sensitiveFields());
  for (const style of styles) {
    const respelled = Object.fromEntries(
      Object.entries(sensitiveFields()).map(([key, value]) => [respell(key, style), value]),
    );
    logger.info({ top: respelled, nested: { inner: respelled }, ...KEPT }, style);
  }
  expect(lines).toHaveLength(3);
  styles.forEach((style, i) => {
    const redacted = Object.fromEntries(keys.map((key) => [respell(key, style), REDACTED]));
    expectLine(lines[i], {
      level: 30,
      top: redacted,
      nested: { inner: redacted },
      ...KEPT,
      msg: style,
    });
  });
});

it('[BR-ID-33] 日志：敏感字段的值是数字、字节（Buffer）、数组、对象、Map 或 Set 时整体只写 [REDACTED]；别的键下的 Map、Set 写成 {}', () => {
  const { logger, lines } = capture();
  const contacts = new Map<string, unknown>([
    ['phone', SAMPLES.phone],
    ['real_name', SAMPLES.realName],
  ]);
  const tags = new Set<unknown>([SAMPLES.bankCard, { id_no: SAMPLES.idNo }]);
  logger.info(
    {
      phone: Number(SAMPLES.phone),
      id_no: Buffer.from(SAMPLES.idNo, 'utf8'),
      bank_card_no: [SAMPLES.bankCard, Buffer.from(SAMPLES.bankCard, 'utf8')],
      payee_account: { number: SAMPLES.bankCard, holder: SAMPLES.payeeName },
      user: { mobile: Number(SAMPLES.contactPhone), real_name: [SAMPLES.realName] },
      phones: new Set([SAMPLES.phone, SAMPLES.alertPhone]),
      realname: new Map([
        ['name', SAMPLES.realName],
        ['id_no', SAMPLES.idNo],
      ]),
      contacts,
      tags,
      ...KEPT,
    },
    'typed values',
  );
  expect(lines).toHaveLength(1);
  expectLine(lines[0], {
    level: 30,
    phone: REDACTED,
    id_no: REDACTED,
    bank_card_no: REDACTED,
    payee_account: REDACTED,
    user: { mobile: REDACTED, real_name: REDACTED },
    phones: REDACTED,
    realname: REDACTED,
    contacts: {},
    tags: {},
    ...KEPT,
    msg: 'typed values',
  });
  expect({ contacts: [...contacts.entries()], tags: [...tags.values()] }).toEqual({
    contacts: [
      ['phone', SAMPLES.phone],
      ['real_name', SAMPLES.realName],
    ],
    tags: [SAMPLES.bankCard, { id_no: SAMPLES.idNo }],
  });
});

it('[BR-ID-33] 日志：错误对象（直接记录、err 下、其他键下、数组里、cause 链、AggregateError）的敏感属性只写 [REDACTED]，message 与 stack 原样，错误本身不被改动', () => {
  const { logger, lines } = capture();
  const direct = errorWithPersonalData('payout failed');
  const underErr = errorWithPersonalData('payout failed');
  const underOther = errorWithPersonalData('nested failure');
  const inner = errorWithPersonalData('inner');
  const middle = new Error('middle', { cause: inner });
  const outer = new Error('outer', { cause: middle });
  const first = errorWithPersonalData('first');
  const second = errorWithPersonalData('second');
  const aggregate = new AggregateError([first, second], 'agg');
  const objectCause = new Error('object cause', {
    cause: { bank_card_no: SAMPLES.bankCard, phone: SAMPLES.phone },
  });
  const listed = errorWithPersonalData('in a list');
  const errors = [
    ...[direct, underErr, underOther, inner, middle, outer],
    ...[first, second, aggregate, objectCause, listed],
  ];
  const before = errors.map(snapshotOf);
  logger.error(direct);
  logger.error({ err: underErr, ...KEPT }, 'with err key');
  logger.warn({ ctx: { failure: underOther }, ...KEPT }, 'other key');
  logger.error({ err: outer }, 'cause chain');
  logger.error({ err: aggregate }, 'aggregate');
  logger.error({ err: objectCause }, 'object cause');
  logger.warn({ failures: [listed], ...KEPT }, 'error list');
  const p = redactedErrorProps();
  expect(lines).toHaveLength(7);
  expectLine(lines[0], { level: 50, err: errorShape('Error', direct, p), msg: 'payout failed' });
  expectLine(lines[1], {
    level: 50,
    err: errorShape('Error', underErr, p),
    ...KEPT,
    msg: 'with err key',
  });
  expectLine(lines[2], {
    level: 40,
    ctx: { failure: errorShape('Error', underOther, p) },
    ...KEPT,
    msg: 'other key',
  });
  expectLine(lines[3], {
    level: 50,
    err: errorShape('Error', outer, {
      cause: errorShape('Error', middle, { cause: errorShape('Error', inner, p) }),
    }),
    msg: 'cause chain',
  });
  expectLine(lines[4], {
    level: 50,
    err: errorShape('AggregateError', aggregate, {
      aggregateErrors: [errorShape('Error', first, p), errorShape('Error', second, p)],
    }),
    msg: 'aggregate',
  });
  expectLine(lines[5], {
    level: 50,
    err: errorShape('Error', objectCause, { cause: { bank_card_no: REDACTED, phone: REDACTED } }),
    msg: 'object cause',
  });
  expectLine(lines[6], {
    level: 40,
    failures: [errorShape('Error', listed, p)],
    ...KEPT,
    msg: 'error list',
  });
  expect(errors.map(snapshotOf)).toEqual(before);
});

it('[BR-ID-33] 日志：子 logger 与孙 logger 的绑定字段（含嵌套）只写 [REDACTED]，绑定对象不被改动', () => {
  const { logger, lines } = capture();
  const bindings = {
    phone: SAMPLES.phone,
    payee: { bank_card_no: SAMPLES.bankCard, payee_name: SAMPLES.payeeName },
  };
  const more = { user: { realname: { name: SAMPLES.realName, id_no: SAMPLES.idNo } } };
  const before = JSON.stringify([bindings, more]);
  const child = logger.child(bindings);
  const grandchild = child.child(more);
  grandchild.info({ order_id: KEPT.order_id }, 'bound');
  child.warn({ amount_fen: KEPT.amount_fen }, 'bound too');
  const payee = { bank_card_no: REDACTED, payee_name: REDACTED };
  expect(lines).toHaveLength(2);
  expectLine(lines[0], {
    level: 30,
    phone: REDACTED,
    payee,
    user: { realname: REDACTED },
    order_id: KEPT.order_id,
    msg: 'bound',
  });
  expectLine(lines[1], {
    level: 40,
    phone: REDACTED,
    payee,
    amount_fen: KEPT.amount_fen,
    msg: 'bound too',
  });
  expect(JSON.stringify([bindings, more])).toBe(before);
});

it('[BR-ID-33] 日志：toJSON 返回的敏感字段同样只写 [REDACTED]；循环引用写成 [Circular] 而不抛错', () => {
  const { logger, lines } = capture();
  const payee = {
    toJSON(): Record<string, unknown> {
      return { bank_card_no: SAMPLES.bankCard, real_name: SAMPLES.realName, phone: SAMPLES.phone };
    },
  };
  logger.info({ payee, ...KEPT }, 'to json');
  const circular: Record<string, unknown> = {
    id_no: SAMPLES.idNo,
    alipay_logon_id: SAMPLES.alipayEmail,
  };
  circular['self'] = circular;
  circular['list'] = [circular, { card_no: SAMPLES.cardNo }];
  expect(() => logger.info({ circular, ...KEPT }, 'circular')).not.toThrow();
  expect(lines).toHaveLength(2);
  expectLine(lines[0], {
    level: 30,
    payee: { bank_card_no: REDACTED, real_name: REDACTED, phone: REDACTED },
    ...KEPT,
    msg: 'to json',
  });
  expectLine(lines[1], {
    level: 30,
    circular: {
      id_no: REDACTED,
      alipay_logon_id: REDACTED,
      self: '[Circular]',
      list: ['[Circular]', { card_no: REDACTED }],
    },
    ...KEPT,
    msg: 'circular',
  });
});

it('[BR-ID-33] 日志：printf 风格参数（%j、%o、%O）的对象按规则替换后再写进 msg，整条 msg 等于期望串', () => {
  const { logger, lines } = capture();
  const args = [
    { bank_card_no: SAMPLES.bankCard, payee_name: SAMPLES.payeeName },
    { phone: SAMPLES.phone, nested: { alipay_logon_id: SAMPLES.alipayEmail } },
    { id_no: SAMPLES.idNo, real_name: SAMPLES.realName },
    { card_no: SAMPLES.cardNo, list: [{ mobile: SAMPLES.phone }] },
  ] as const;
  const before = JSON.stringify(args);
  logger.info('payee %j, user %o, realname %O', args[0], args[1], args[2]);
  logger.warn({ ...KEPT }, 'card %j', args[3]);
  expect(lines).toHaveLength(2);
  expectLine(lines[0], {
    level: 30,
    msg:
      'payee {"bank_card_no":"[REDACTED]","payee_name":"[REDACTED]"}, ' +
      'user {"phone":"[REDACTED]","nested":{"alipay_logon_id":"[REDACTED]"}}, ' +
      'realname {"id_no":"[REDACTED]","real_name":"[REDACTED]"}',
  });
  expectLine(lines[1], {
    level: 40,
    ...KEPT,
    msg: 'card {"card_no":"[REDACTED]","list":[{"mobile":"[REDACTED]"}]}',
  });
  expect(JSON.stringify(args)).toBe(before);
});

it('[BR-ID-33] Nest 日志适配器：对象消息写成替换后的 JSON、附加参数与错误对象按规则替换，context 与 stack 参数原样', () => {
  const { nest: adapter, lines } = captureNest();
  const failure = errorWithPersonalData('payout failed');
  const stackText = 'Error: payout failed\n    at Payout.run (payout.ts:10:5)';
  adapter.log({ bank_card_no: SAMPLES.bankCard, real_name: SAMPLES.realName }, 'Payout');
  adapter.warn('payee checked', { id_no: SAMPLES.idNo, phone: SAMPLES.phone }, 'Payee');
  adapter.error(failure, 'Payout');
  adapter.debug({
    nested: { alipay_logon_id: SAMPLES.alipayEmail, payee_name: SAMPLES.payeeName },
  });
  adapter.fatal({ payout: [{ card_no: SAMPLES.cardNo }] }, 'Boot');
  adapter.error('payout failed', stackText, 'Payout');
  adapter.verbose('route mapped', 'Router');
  expect(lines).toHaveLength(7);
  expectLine(lines[0], {
    level: 30,
    context: 'Payout',
    msg: '{"bank_card_no":"[REDACTED]","real_name":"[REDACTED]"}',
  });
  expectLine(lines[1], {
    level: 40,
    context: 'Payee',
    params: [{ id_no: REDACTED, phone: REDACTED }],
    msg: 'payee checked',
  });
  expectLine(lines[2], {
    level: 50,
    context: 'Payout',
    err: errorShape('Error', failure, redactedErrorProps()),
    msg: 'payout failed',
  });
  expectLine(lines[3], {
    level: 20,
    msg: '{"nested":{"alipay_logon_id":"[REDACTED]","payee_name":"[REDACTED]"}}',
  });
  expectLine(lines[4], {
    level: 60,
    context: 'Boot',
    msg: '{"payout":[{"card_no":"[REDACTED]"}]}',
  });
  expectLine(lines[5], { level: 50, context: 'Payout', stack: stackText, msg: 'payout failed' });
  expectLine(lines[6], { level: 10, context: 'Router', msg: 'route mapped' });
});
