// Rule tests for 规划/08 BR-ID-33「日志中不得出现明文」through the real root logger and the Nest
// adapter of apps/api/src/modules/platform/logging. The sensitive names, the channels (depth,
// arrays, key spellings, value types, errors, child bindings, toJSON, the Nest adapter) and what
// must stay unchanged are the contract written in apps/api/src/modules/platform/masking/index.ts.
// A leak is found by kit.ts `leaksIn`: fragments of the plaintext, also as UTF-8 bytes. Every
// test also checks that ordinary fields survive, so dropping whole records cannot pass.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  KEPT,
  SAMPLES,
  capture,
  captureNest,
  errorWithPersonalData,
  leaksIn,
  nest,
  respell,
  sensitiveFields,
} from './kit.ts';

it('[BR-ID-33] 日志：顶层的手机号、身份证号、姓名、收款账号与凭据字段都不出明文，其他字段原样保留', () => {
  const { logger, lines, records } = capture();
  logger.info({ ...sensitiveFields(), ...KEPT }, 'payout requested');
  expect({ lines: lines.length, leaks: leaksIn(lines[0] ?? '{}') }).toEqual({
    lines: 1,
    leaks: [],
  });
  expect(records()[0]).toMatchObject({ ...KEPT, level: 30, msg: 'payout requested' });
});

class PayeeRecord {
  readonly bank_card_no = SAMPLES.bankCard;
  readonly payee_name = SAMPLES.payeeName;
  readonly payout_method = 'bank_card';
}

it('[BR-ID-33] 日志：任意深度（第 2、3、6、12 层）、数组、无原型对象与类实例里的敏感字段都被替换，调用方的对象不被改动', () => {
  const { logger, lines, records } = capture();
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
  expect({ lines: lines.length, leaks: leaksIn(lines[0] ?? '{}') }).toEqual({
    lines: 1,
    leaks: [],
  });
  expect(records()[0]).toMatchObject({ ...KEPT, level: 40, msg: 'deep' });
  expect(JSON.stringify(deep)).toBe(before);
});

it('[BR-ID-33] 日志：键名不分大小写与分隔符（bankCardNo、BANK_CARD_NO、bank-card-no 与 bank_card_no 同样替换）', () => {
  const { logger, lines } = capture();
  for (const style of ['camel', 'upper', 'kebab'] as const) {
    const respelled = Object.fromEntries(
      Object.entries(sensitiveFields()).map(([key, value]) => [respell(key, style), value]),
    );
    logger.info({ top: respelled, nested: { inner: respelled }, ...KEPT }, style);
  }
  expect({ lines: lines.length, leaks: lines.map((line) => leaksIn(line)) }).toEqual({
    lines: 3,
    leaks: [[], [], []],
  });
});

it('[BR-ID-33] 日志：敏感字段的值是数字、字节（Buffer）、数组或对象时整体替换', () => {
  const { logger, lines, records } = capture();
  logger.info(
    {
      phone: Number(SAMPLES.phone),
      id_no: Buffer.from(SAMPLES.idNo, 'utf8'),
      bank_card_no: [SAMPLES.bankCard, Buffer.from(SAMPLES.bankCard, 'utf8')],
      payee_account: { number: SAMPLES.bankCard, holder: SAMPLES.payeeName },
      user: { mobile: Number(SAMPLES.contactPhone), real_name: [SAMPLES.realName] },
      ...KEPT,
    },
    'typed values',
  );
  expect({ lines: lines.length, leaks: leaksIn(lines[0] ?? '{}') }).toEqual({
    lines: 1,
    leaks: [],
  });
  expect(records()[0]).toMatchObject(KEPT);
});

it('[BR-ID-33] 日志：错误对象的敏感属性在 err 下、在其他键下、沿 cause 链与 AggregateError 里都被替换，错误本身不被改动', () => {
  const { logger, lines, records } = capture();
  const direct = errorWithPersonalData('payout failed');
  logger.error(direct);
  logger.error({ err: errorWithPersonalData('payout failed'), ...KEPT }, 'with err key');
  logger.warn({ ctx: { failure: errorWithPersonalData('nested failure') }, ...KEPT }, 'other key');
  logger.error(
    {
      err: new Error('outer', {
        cause: new Error('middle', { cause: errorWithPersonalData('inner') }),
      }),
    },
    'cause chain',
  );
  logger.error(
    {
      err: new AggregateError([errorWithPersonalData('first'), errorWithPersonalData('x')], 'agg'),
    },
    'aggregate',
  );
  logger.error(
    {
      err: new Error('object cause', {
        cause: { bank_card_no: SAMPLES.bankCard, phone: SAMPLES.phone },
      }),
    },
    'object cause',
  );
  logger.warn({ failures: [errorWithPersonalData('in a list')], ...KEPT }, 'error list');
  expect({ lines: lines.length, leaks: lines.map((line) => leaksIn(line)) }).toEqual({
    lines: 7,
    leaks: [[], [], [], [], [], [], []],
  });
  const [first, second] = records();
  expect((first?.['err'] as { message?: unknown } | undefined)?.message).toBe('payout failed');
  expect((second?.['err'] as { message?: unknown } | undefined)?.message).toBe('payout failed');
  expect(second).toMatchObject(KEPT);
  expect({
    phone: (direct as unknown as Record<string, unknown>)['phone'],
    bank: (direct as unknown as Record<string, unknown>)['bank_card_no'],
  }).toEqual({ phone: SAMPLES.phone, bank: SAMPLES.bankCard });
});

it('[BR-ID-33] 日志：子 logger 的绑定字段（含嵌套）同样替换', () => {
  const { logger, lines, records } = capture();
  const child = logger.child({
    phone: SAMPLES.phone,
    payee: { bank_card_no: SAMPLES.bankCard, payee_name: SAMPLES.payeeName },
  });
  const grandchild = child.child({
    user: { realname: { name: SAMPLES.realName, id_no: SAMPLES.idNo } },
  });
  grandchild.info({ order_id: KEPT.order_id }, 'bound');
  child.warn({ amount_fen: KEPT.amount_fen }, 'bound too');
  expect({ lines: lines.length, leaks: lines.map((line) => leaksIn(line)) }).toEqual({
    lines: 2,
    leaks: [[], []],
  });
  expect(records().map((r) => [r['order_id'] ?? null, r['amount_fen'] ?? null])).toEqual([
    [KEPT.order_id, null],
    [null, KEPT.amount_fen],
  ]);
});

it('[BR-ID-33] 日志：toJSON 返回的敏感字段同样替换；循环引用不抛错', () => {
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
  expect({ lines: lines.length, leaks: lines.map((line) => leaksIn(line)) }).toEqual({
    lines: 2,
    leaks: [[], []],
  });
});

it('[BR-ID-33] 日志：printf 风格参数（%j、%o、%O）里的对象写进 msg 之前同样替换', () => {
  const { logger, lines, records } = capture();
  logger.info(
    'payee %j, user %o, realname %O',
    { bank_card_no: SAMPLES.bankCard, payee_name: SAMPLES.payeeName },
    { phone: SAMPLES.phone, nested: { alipay_logon_id: SAMPLES.alipayEmail } },
    { id_no: SAMPLES.idNo, real_name: SAMPLES.realName },
  );
  logger.warn({ ...KEPT }, 'card %j', {
    card_no: SAMPLES.cardNo,
    list: [{ mobile: SAMPLES.phone }],
  });
  expect({ lines: lines.length, leaks: lines.map((line) => leaksIn(line)) }).toEqual({
    lines: 2,
    leaks: [[], []],
  });
  expect(records()[1]).toMatchObject(KEPT);
});

it('[BR-ID-33] Nest 日志适配器：对象消息、附加参数与错误对象都不出明文', () => {
  const { nest: adapter, lines, records } = captureNest();
  adapter.log({ bank_card_no: SAMPLES.bankCard, real_name: SAMPLES.realName }, 'Payout');
  adapter.warn('payee checked', { id_no: SAMPLES.idNo, phone: SAMPLES.phone }, 'Payee');
  adapter.error(errorWithPersonalData('payout failed'), 'Payout');
  adapter.debug({
    nested: { alipay_logon_id: SAMPLES.alipayEmail, payee_name: SAMPLES.payeeName },
  });
  adapter.fatal({ payout: [{ card_no: SAMPLES.cardNo }] }, 'Boot');
  expect({ lines: lines.length, leaks: lines.map((line) => leaksIn(line)) }).toEqual({
    lines: 5,
    leaks: [[], [], [], [], []],
  });
  expect(records().map((r) => [r['level'], r['context'] ?? null])).toEqual([
    [30, 'Payout'],
    [40, 'Payee'],
    [50, 'Payout'],
    [20, null],
    [60, 'Boot'],
  ]);
});
