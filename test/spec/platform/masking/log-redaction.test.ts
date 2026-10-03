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

it('[BR-ID-33] 日志：错误对象（直接记录、err 下、其他键下、数组里、cause 链、AggregateError）的敏感属性只写 [REDACTED]，message 与 stack 不被改写，错误本身不被改动', () => {
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

it('[BR-ID-33] 日志：child() 与 setBindings() 给根 logger、子 logger、孙 logger 的绑定字段（含嵌套）只写 [REDACTED]，绑定对象不被改动', () => {
  const { logger, lines } = capture();
  const bindings = {
    phone: SAMPLES.phone,
    payee: { bank_card_no: SAMPLES.bankCard, payee_name: SAMPLES.payeeName },
  };
  const more = { user: { realname: { name: SAMPLES.realName, id_no: SAMPLES.idNo } } };
  const rootSet = { account: { alipay_logon_id: SAMPLES.alipayEmail, card_no: SAMPLES.cardNo } };
  const childSet = { contact: { mobile: SAMPLES.contactPhone, id_card: SAMPLES.idNo15 } };
  const grandSet = { auth: { token: SAMPLES.credential } };
  const before = JSON.stringify([bindings, more, rootSet, childSet, grandSet]);
  const child = logger.child(bindings);
  const grandchild = child.child(more);
  grandchild.info({ order_id: KEPT.order_id }, 'bound');
  child.warn({ amount_fen: KEPT.amount_fen }, 'bound too');
  logger.setBindings(rootSet);
  logger.info({ user_id: KEPT.user_id }, 'root set');
  child.setBindings(childSet);
  child.info('child set');
  grandchild.setBindings(grandSet);
  grandchild.info('grandchild set');
  const payee = { bank_card_no: REDACTED, payee_name: REDACTED };
  const user = { realname: REDACTED };
  expect(lines).toHaveLength(5);
  expectLine(lines[0], {
    level: 30,
    phone: REDACTED,
    payee,
    user,
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
  expectLine(lines[2], {
    level: 30,
    account: { alipay_logon_id: REDACTED, card_no: REDACTED },
    user_id: KEPT.user_id,
    msg: 'root set',
  });
  expectLine(lines[3], {
    level: 30,
    phone: REDACTED,
    payee,
    contact: { mobile: REDACTED, id_card: REDACTED },
    msg: 'child set',
  });
  expectLine(lines[4], {
    level: 30,
    phone: REDACTED,
    payee,
    user,
    auth: { token: REDACTED },
    msg: 'grandchild set',
  });
  expect(JSON.stringify([bindings, more, rootSet, childSet, grandSet])).toBe(before);
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
  // Nested names and credentials too: the free-text safety net cannot recognise those, so only
  // the rules for values keep them out of msg.
  const args = [
    { bank_card_no: SAMPLES.bankCard, payee_name: SAMPLES.payeeName },
    {
      phone: SAMPLES.phone,
      nested: { alipay_logon_id: SAMPLES.alipayEmail, payee_name: SAMPLES.payeeName },
    },
    { id_no: SAMPLES.idNo, real_name: SAMPLES.realName },
    {
      card_no: SAMPLES.cardNo,
      list: [{ mobile: SAMPLES.phone, real_name: SAMPLES.realName, token: SAMPLES.credential }],
    },
  ] as const;
  const before = JSON.stringify(args);
  logger.info('payee %j, user %o, realname %O', args[0], args[1], args[2]);
  logger.warn({ ...KEPT }, 'card %j', args[3]);
  expect(lines).toHaveLength(2);
  expectLine(lines[0], {
    level: 30,
    msg:
      'payee {"bank_card_no":"[REDACTED]","payee_name":"[REDACTED]"}, ' +
      'user {"phone":"[REDACTED]","nested":{"alipay_logon_id":"[REDACTED]","payee_name":"[REDACTED]"}}, ' +
      'realname {"id_no":"[REDACTED]","real_name":"[REDACTED]"}',
  });
  expectLine(lines[1], {
    level: 40,
    ...KEPT,
    msg: 'card {"card_no":"[REDACTED]","list":[{"mobile":"[REDACTED]","real_name":"[REDACTED]","token":"[REDACTED]"}]}',
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

// Free text (contract: the safety net). One string with every kind the net recognises, in the
// spellings the contract names, pushed through every free-text channel.
const FREE =
  '手机号13987654321，又 139 8765 4321，证件 11010519491231002X，' +
  '卡 6222 0212 3456 7890 123，邮箱 qzx7.vwk3@exmpl-host.cn，全角１３９８７６５４３２１';
const SCRUBBED =
  '手机号[REDACTED]，又 [REDACTED]，证件 [REDACTED]，' +
  '卡 [REDACTED]，邮箱 [REDACTED]，全角[REDACTED]';

/** `error`'s stack with the free text in its first line scrubbed: the frames stay as they are. */
function scrubbedStack(error: Error): string {
  return (error.stack ?? '').split(FREE).join(SCRUBBED);
}

it('[BR-ID-33] 日志：自由文本安全网逐种写法替换手机号（含 +86、空格、连字符、全角）、身份证号（18 位末位为数字或 X、15 位）、银行卡号（16～19 位逐个长度）与邮箱，别的数字与文字原样', () => {
  const { logger, lines } = capture();
  const cases: readonly (readonly [string, string])[] = [
    ['手机号13987654321核验失败', '手机号[REDACTED]核验失败'],
    ['电话 139 8765 4321。', '电话 [REDACTED]。'],
    ['电话 139-8765-4321', '电话 [REDACTED]'],
    [
      '+86 13987654321 / 8613987654321 / 0086-139-8765-4321',
      '[REDACTED] / [REDACTED] / [REDACTED]',
    ],
    ['全角１３９８７６５４３２１号', '全角[REDACTED]号'],
    [
      '证件 11010519491231002X，11010519491231002x，110105 19491231 002X，320105791231247',
      '证件 [REDACTED]，[REDACTED]，[REDACTED]，[REDACTED]',
    ],
    [
      '卡 6222021234567890123，4392 2600 1234 5678，6222-0212-3456-7890-123',
      '卡 [REDACTED]，[REDACTED]，[REDACTED]',
    ],
    // Every length from 15 to 19 without separators, an 18-digit ID number ending in a digit,
    // and spaced 15- and 17-digit numbers.
    [
      '证件 110105194912310011，卡 4392260012345678，62220212345678901，622202123456789012',
      '证件 [REDACTED]，卡 [REDACTED]，[REDACTED]，[REDACTED]',
    ],
    ['旧证件 320105 791231 247，卡 6222 0212 3456 7890 1', '旧证件 [REDACTED]，卡 [REDACTED]'],
    ['全角证件１１０１０５１９４９１２３１００１１', '全角证件[REDACTED]'],
    ['邮箱 qzx7.vwk3@exmpl-host.cn，zh.san@example.com', '邮箱 [REDACTED]，[REDACTED]'],
    // Not a match: too short or too long, a mobile number must start with 1, a domain must end in
    // letters, dates and amounts. Nothing here may change.
    [
      '1357924680，135792468024，23579246801，35792468013579，35792468013579246801',
      '1357924680，135792468024，23579246801，35792468013579，35792468013579246801',
    ],
    ['3579246801357，8635792468013', '3579246801357，8635792468013'],
    [
      '订单 135792468，金额 1999 分，版本 v10.3.1，pino@10.3.1，时间 2026-10-04 08:00:00',
      '订单 135792468，金额 1999 分，版本 v10.3.1，pino@10.3.1，时间 2026-10-04 08:00:00',
    ],
  ];
  for (const [text] of cases) logger.info(text);
  expect(lines).toHaveLength(cases.length);
  cases.forEach(([, expected], i) => {
    expectLine(lines[i], { level: 30, msg: expected });
  });
});

it('[BR-ID-33] 日志：自由文本安全网覆盖每个通道：msg（字符串、数字、printf 结果、子 logger 的 msgPrefix、对象自带的 msg、回落的 err.message）、任意深度 msg / message / stack 键下的值、错误（直接记录、err 下、其他键下、属性里、cause、AggregateError）的 message 与 stack，Nest 的消息、context、stack 参数与字符串参数', () => {
  const { logger, lines } = capture();
  const direct = new Error(FREE);
  const cause = new Error(FREE);
  const outer = new Error('outer', { cause });
  const listed = new Error(FREE);
  const aggregate = new AggregateError([listed], FREE);
  const inner = new Error(FREE);
  const nested = Object.assign(new Error(FREE), { inner });
  const fallback = new Error(FREE);
  logger.warn(FREE);
  logger.info('note %s; data %j', FREE, { text: FREE });
  logger.child({ order_id: KEPT.order_id }, { msgPrefix: `${FREE}: ` }).info('checked');
  logger.error(direct);
  logger.error({ err: outer }, 'cause chain');
  logger.error({ err: aggregate }, 'aggregate');
  logger.warn({ ctx: { failure: nested }, ...KEPT }, 'other key');
  // No message argument: pino writes the object's own msg, or falls back to err.message.
  logger.info({ msg: FREE, order_id: KEPT.order_id });
  logger.error({ err: fallback });
  logger.warn({ err: { message: FREE, code: 'E_PAYEE' } });
  logger.info({ result: { message: FREE, stack: FREE, status: 'failed' } }, 'result');
  logger.info(13987654321);
  logger.info({ msg: 13987654321 });
  const { nest: adapter, lines: nestLines } = captureNest();
  const nestError = new Error(FREE);
  adapter.log(FREE, 'Payout');
  adapter.warn('payee checked', FREE, 'Payee');
  adapter.error('payout failed', `Error: ${FREE}\n    at Payout.run (payout.ts:10:5)`, 'Payout');
  adapter.error(nestError, 'Payout');
  adapter.debug({ text: FREE });
  adapter.log('context check', FREE);
  adapter.log(13987654321, 'Payout');
  expect({ lines: lines.length, nestLines: nestLines.length }).toEqual({
    lines: 13,
    nestLines: 7,
  });
  expectLine(lines[0], { level: 40, msg: SCRUBBED });
  expectLine(lines[1], {
    level: 30,
    msg: `note ${SCRUBBED}; data {"text":"${SCRUBBED}"}`,
  });
  expectLine(lines[2], { level: 30, order_id: KEPT.order_id, msg: `${SCRUBBED}: checked` });
  expectLine(lines[3], {
    level: 50,
    err: { type: 'Error', message: SCRUBBED, stack: scrubbedStack(direct) },
    msg: SCRUBBED,
  });
  expectLine(lines[4], {
    level: 50,
    err: errorShape('Error', outer, {
      cause: { type: 'Error', message: SCRUBBED, stack: scrubbedStack(cause) },
    }),
    msg: 'cause chain',
  });
  expectLine(lines[5], {
    level: 50,
    err: {
      type: 'AggregateError',
      message: SCRUBBED,
      stack: scrubbedStack(aggregate),
      aggregateErrors: [{ type: 'Error', message: SCRUBBED, stack: scrubbedStack(listed) }],
    },
    msg: 'aggregate',
  });
  expectLine(lines[6], {
    level: 40,
    ctx: {
      failure: {
        type: 'Error',
        message: SCRUBBED,
        stack: scrubbedStack(nested),
        inner: { type: 'Error', message: SCRUBBED, stack: scrubbedStack(inner) },
      },
    },
    ...KEPT,
    msg: 'other key',
  });
  expectLine(lines[7], { level: 30, msg: SCRUBBED, order_id: KEPT.order_id });
  expectLine(lines[8], {
    level: 50,
    err: { type: 'Error', message: SCRUBBED, stack: scrubbedStack(fallback) },
    msg: SCRUBBED,
  });
  expectLine(lines[9], { level: 40, err: { message: SCRUBBED, code: 'E_PAYEE' }, msg: SCRUBBED });
  expectLine(lines[10], {
    level: 30,
    result: { message: SCRUBBED, stack: SCRUBBED, status: 'failed' },
    msg: 'result',
  });
  expectLine(lines[11], { level: 30, msg: REDACTED });
  expectLine(lines[12], { level: 30, msg: REDACTED });
  expectLine(nestLines[0], { level: 30, context: 'Payout', msg: SCRUBBED });
  expectLine(nestLines[1], {
    level: 40,
    context: 'Payee',
    params: [SCRUBBED],
    msg: 'payee checked',
  });
  expectLine(nestLines[2], {
    level: 50,
    context: 'Payout',
    stack: `Error: ${SCRUBBED}\n    at Payout.run (payout.ts:10:5)`,
    msg: 'payout failed',
  });
  expectLine(nestLines[3], {
    level: 50,
    context: 'Payout',
    err: { type: 'Error', message: SCRUBBED, stack: scrubbedStack(nestError) },
    msg: SCRUBBED,
  });
  expectLine(nestLines[4], { level: 20, msg: `{"text":"${SCRUBBED}"}` });
  expectLine(nestLines[5], { level: 30, context: SCRUBBED, msg: 'context check' });
  expectLine(nestLines[6], { level: 30, context: 'Payout', msg: REDACTED });
});
