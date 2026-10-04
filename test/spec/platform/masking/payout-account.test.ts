// Rule tests for the payout account masking of 规划/08 BR-ID-33 细则「收款账号的脱敏格式」(功能对照
// G-71): 支付宝登录号 phone form 138****5678 and e-mail form zh***@example.com / a***@x.com /
// ***@x.com, 银行卡 「尾号 1234」, 收款人姓名 like 姓名 (**三). Contract (including the handling of
// inputs that are not of an accepted form): apps/api/src/modules/platform/masking/payout-account.ts.
// Lengths count code points. Expected values are written out by hand. Every call goes through
// `run`, which turns a thrown error into a string, so a function that throws fails an assertion
// (and shows the error in the diff) instead of aborting the test. Top-level it() only
// (规划/11 §4.3); property runs and seed only from @couli/testing.
import { propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  maskAlipayLogonId,
  maskBankCardTail,
  maskPayeeName,
} from '../../../../apps/api/src/modules/platform/masking/payout-account.ts';

type Mask = (text: string) => string;

/** The result of `mask(text)`, or `threw <name>: <message>` when it throws. */
function run(mask: Mask, text: string): string {
  try {
    const out: unknown = mask(text);
    return typeof out === 'string' ? out : `returned ${typeof out}`;
  } catch (error) {
    return error instanceof Error
      ? `threw ${error.name}: ${error.message}`
      : `threw ${String(error)}`;
  }
}

function runAll(mask: Mask, inputs: readonly string[]): string[] {
  return inputs.map((text) => run(mask, text));
}

function stars(text: string): string {
  return '*'.repeat([...text].length);
}

it('[BR-ID-33 收款账号的脱敏格式] 原文的例子逐字：138****5678、zh***@example.com、a***@x.com、***@x.com、尾号 1234、**三', () => {
  expect([
    run(maskAlipayLogonId, '13812345678'),
    run(maskAlipayLogonId, 'zhangsan@example.com'),
    run(maskAlipayLogonId, 'ab@x.com'),
    run(maskAlipayLogonId, 'a@x.com'),
    run(maskBankCardTail, '6225880212341234'),
    run(maskPayeeName, '张小三'),
  ]).toEqual(['138****5678', 'zh***@example.com', 'a***@x.com', '***@x.com', '尾号 1234', '**三']);
});

it('[BR-ID-33 收款账号的脱敏格式] 支付宝邮箱形式：「@」前 1 位不留、2 位留 1 位、3 位及更长留前 2 位，其余固定换成 ***，按码点计', () => {
  const cases: [string, string][] = [
    ['a@x.com', '***@x.com'],
    ['ab@x.com', 'a***@x.com'],
    ['abc@x.com', 'ab***@x.com'],
    ['abcd@x.com', 'ab***@x.com'],
    ['zhangsan@example.com', 'zh***@example.com'],
    ['abcdefghijklmnopqrstuvwxyz0123456789@x.com', 'ab***@x.com'],
    ['a.b@x.com', 'a.***@x.com'],
    ['_@x.com', '***@x.com'],
    ['张三@x.com', '张***@x.com'],
    ['张小三@x.com', '张小***@x.com'],
    ['\u{20BB7}@x.com', '***@x.com'],
    ['\u{20BB7}\u{20BB7}@x.com', '\u{20BB7}***@x.com'],
    ['\u{20BB7}\u{20BB7}\u{20BB7}@x.com', '\u{20BB7}\u{20BB7}***@x.com'],
    ['\u{1F600}a@x.com', '\u{1F600}***@x.com'],
    ['\u{1F600}\u{1F600}a@x.com', '\u{1F600}\u{1F600}***@x.com'],
    ['e\u0301b@x.com', 'e\u0301***@x.com'],
    ['*a@x.com', '****@x.com'],
  ];
  expect(
    runAll(
      maskAlipayLogonId,
      cases.map(([input]) => input),
    ),
  ).toEqual(cases.map(([, output]) => output));
});

it('[BR-ID-33 收款账号的脱敏格式] 支付宝邮箱形式：「@」与域名原样显示（大小写不变、不要求带点、子域名与中文域名照旧），本地部分保留的字符也不改大小写', () => {
  const cases: [string, string][] = [
    ['ZhangSan@Example.COM', 'Zh***@Example.COM'],
    ['AB@X.COM', 'A***@X.COM'],
    ['Ab@x.com', 'A***@x.com'],
    ['ab@x', 'a***@x'],
    ['abc@mail.sub.example.com.cn', 'ab***@mail.sub.example.com.cn'],
    ['abc@例子.中国', 'ab***@例子.中国'],
    ['abc@x-y.com', 'ab***@x-y.com'],
    ['abc@.', 'ab***@.'],
  ];
  expect(
    runAll(
      maskAlipayLogonId,
      cases.map(([input]) => input),
    ),
  ).toEqual(cases.map(([, output]) => output));
});

it('[BR-ID-33 收款账号的脱敏格式] 支付宝邮箱形式不合规（「@」前或后为空、多个「@」、任何位置有空白或 \\p{C} 字符）时不露任何字符：每个码点换成 *', () => {
  const inputs = [
    '@',
    '@@',
    '@x.com',
    'zh@',
    'a@b@x.com',
    'zh@@x.com',
    '@zh@x.com',
    'zh@x.com@',
    ' zh@x.com',
    'zh@x.com ',
    'zh @x.com',
    'zh@ x.com',
    'zh@x .com',
    '\tzh@x.com',
    'zh@x.com\n',
    'zh@x.com\r\n',
    'zh\u00A0@x.com',
    'zh@x.com\u3000',
    'zh\u2028@x.com',
    'zh\u200B@x.com',
    'z\u200Dh@x.com',
    '\uFEFFzh@x.com',
    'zh@x.com\u0000',
    'zh\u007F@x.com',
    'zh\uE000@x.com',
    'zh\uD800@x.com',
    'zh@x\uDC00.com',
    '\uDBFF@x.com',
  ];
  expect(runAll(maskAlipayLogonId, inputs)).toEqual(inputs.map(stars));
});

it('[BR-ID-33 收款账号的脱敏格式] 支付宝手机号形式（不含「@」）同手机号：11 位 1 开头的 ASCII 数字露前 3 后 4，其余全是 *', () => {
  expect(
    runAll(maskAlipayLogonId, ['13812345678', '13987654321', '19900001111', '10000000000']),
  ).toEqual(['138****5678', '139****4321', '199****1111', '100****0000']);
});

it('[BR-ID-33 收款账号的脱敏格式] 支付宝手机号形式的反例：10 位、12 位、+86 / 86 / 0086 前缀、分隔符、全角数字、全角「＠」、首位不是 1、前后空白一律每个码点换成 *', () => {
  const inputs = [
    '',
    '1381234567',
    '138123456789',
    '+8613812345678',
    '8613812345678',
    '008613812345678',
    '+86 13812345678',
    '138 1234 5678',
    '138-1234-5678',
    '23812345678',
    '1381234567a',
    ' 13812345678',
    '13812345678 ',
    '13812345678\n',
    '１３８１２３４５６７８',
    '138123456７8',
    '١٣٨١٢٣٤٥٦٧٨',
    'zh＠example.com',
    'zhangsan',
    '1',
  ];
  expect(runAll(maskAlipayLogonId, inputs)).toEqual(inputs.map(stars));
});

it('[BR-ID-33 收款账号的脱敏格式; 规划/08 BR-WDR-02 卡号规范化] 银行卡逐个长度：12～19 位 ASCII 数字得到「尾号」+ 一个空格 + 后 4 位，11 位与 20 位每个码点换成 *（12～15 位待编排会话确认）', () => {
  const cards = [
    '62220212345',
    '622202123456',
    '6222021234567',
    '62220212345678',
    '622202123456789',
    '6222021234567890',
    '62220212345678901',
    '622202123456789012',
    '6222021234567890123',
    '62220212345678901234',
  ];
  expect(runAll(maskBankCardTail, cards)).toEqual([
    '***********',
    '尾号 3456',
    '尾号 4567',
    '尾号 5678',
    '尾号 6789',
    '尾号 7890',
    '尾号 8901',
    '尾号 9012',
    '尾号 0123',
    '********************',
  ]);
});

it('[BR-ID-33 收款账号的脱敏格式] 银行卡只认 ASCII 数字、不做 Luhn 校验：末位不同的两个 16 位卡号都给出各自的尾号；全 0 卡号同样', () => {
  expect(
    runAll(maskBankCardTail, ['6222021234567890', '6222021234567891', '0000000000000000']),
  ).toEqual(['尾号 7890', '尾号 7891', '尾号 0000']);
});

it('[BR-ID-33 收款账号的脱敏格式] 银行卡反例：空串、过短、空格或连字符分组、全角或其他文字的数字、字母、前后空白、加号一律每个码点换成 *，不出现「尾号」', () => {
  const inputs = [
    '',
    '1',
    '1234',
    '12345678901',
    '6222 0212 3456 7890',
    '6222-0212-3456-7890',
    ' 6222021234567890',
    '6222021234567890 ',
    '6222021234567890\n',
    '６２２２０２１２３４５６７８９０',
    '622202123456789０',
    '٦٢٢٢٠٢١٢٣٤٥٦٧٨٩٠',
    '622202123456789X',
    '+6222021234567890',
    '6222021234567890123456789',
    '尾号 7890',
    '6222021234567\u{1F600}890',
  ];
  expect(runAll(maskBankCardTail, inputs)).toEqual(inputs.map(stars));
});

it('[BR-ID-33 收款人姓名同姓名格式] 收款人姓名 1～4 个码点（含代理对生僻字）：n−1 个 * 加末字，单字为 *，空串仍是空串', () => {
  const cases: [string, string][] = [
    ['', ''],
    ['王', '*'],
    ['李四', '*四'],
    ['张小三', '**三'],
    ['欧阳明月', '***月'],
    ['\u{20BB7}', '*'],
    ['\u{20BB7}\u{20BB7}', '*\u{20BB7}'],
    ['张\u{20BB7}', '*\u{20BB7}'],
    ['\u{20BB7}小三', '**三'],
    ['欧阳\u{20BB7}\u{2A6A5}', '***\u{2A6A5}'],
    ['阿依古丽·买买提', '*******提'],
    ['John Smith', '*********h'],
    ['\uD800', '*'],
    ['张\uD800', '*\uD800'],
  ];
  expect(
    runAll(
      maskPayeeName,
      cases.map(([input]) => input),
    ),
  ).toEqual(cases.map(([, output]) => output));
});

it('[BR-ID-33 收款账号的脱敏格式] 三个函数对任何字符串都不抛错、只返回字符串，结果只由入参决定：顺序打乱、交错调用、重复调用结果相同', () => {
  const inputs = [
    '',
    '13812345678',
    'zhangsan@example.com',
    'Ab@X.com',
    'a@b@x.com',
    '6222021234567890',
    '6222 0212 3456 7890',
    '张小三',
    '\uD800',
    '\uDC00\uD800',
    '\u0000',
    '@'.repeat(64),
    `${'a'.repeat(10_000)}@x.com`,
    '6'.repeat(100_000),
  ];
  const masks: Mask[] = [maskAlipayLogonId, maskBankCardTail, maskPayeeName];
  const first = masks.map((mask) => runAll(mask, inputs));
  const reversed = masks
    .slice()
    .reverse()
    .map((mask) => runAll(mask, inputs.slice().reverse()).reverse())
    .reverse();
  const interleaved = masks.map(() => [] as string[]);
  for (const text of inputs) {
    masks.forEach((mask, index) => {
      interleaved[index]?.push(run(mask, text));
    });
  }
  expect(reversed).toEqual(first);
  expect(interleaved).toEqual(first);
  expect([
    first[0]?.[2],
    first[0]?.[3],
    first[0]?.[4],
    first[0]?.[12],
    first[1]?.[5],
    first[1]?.[13],
    first[2]?.[7],
  ]).toEqual([
    'zh***@example.com',
    'A***@X.com',
    '*********',
    'aa***@x.com',
    '尾号 7890',
    '*'.repeat(100_000),
    '**三',
  ]);
});

// Oracles for the property tests, written from the contract.
function oracleLogonId(text: string): string {
  if (!text.includes('@')) {
    return /^1[0-9]{10}$/.test(text) ? `${text.slice(0, 3)}****${text.slice(7)}` : stars(text);
  }
  const parts = text.split('@');
  const local = [...(parts[0] ?? '')];
  if (parts.length !== 2 || local.length === 0 || parts[1] === '' || /[\s\p{C}]/u.test(text)) {
    return stars(text);
  }
  const kept = local.length >= 3 ? 2 : local.length - 1;
  return `${local.slice(0, kept).join('')}***@${parts[1] ?? ''}`;
}

function oracleCard(text: string): string {
  return /^[0-9]{12,19}$/.test(text) ? `尾号 ${text.slice(-4)}` : stars(text);
}

function oracleName(text: string): string {
  const chars = [...text];
  return chars.length < 2 ? stars(text) : '*'.repeat(chars.length - 1) + (chars.at(-1) ?? '');
}

// Generators: arbitrary strings (any code point, also lone surrogates) mixed with strings of the
// accepted shapes, so both branches of every function are exercised in each run.
const anyText = fc.string({ unit: 'binary', maxLength: 24 });
const logonShape = fc.oneof(
  fc.stringMatching(/^1[0-9]{10}$/),
  fc.stringMatching(/^[A-Za-z0-9._%+-]{1,8}@[A-Za-z0-9.-]{1,12}$/),
  fc
    .tuple(
      fc.string({ unit: 'binary', minLength: 1, maxLength: 5 }),
      fc.string({ unit: 'binary', minLength: 1, maxLength: 5 }),
    )
    .map(([local, domain]) => `${local.replaceAll('@', '')}@${domain.replaceAll('@', '')}`),
);
const cardShape = fc.stringMatching(/^[0-9]{10,21}$/);

// GitHub runners are several times slower than a laptop: the property tests get a timeout that
// grows with PROP_RUNS (10 000 locally, 100 000 in CI) instead of the default 5 seconds.
const PROPERTY_TIMEOUT_MS: number = Math.max(30_000, Math.ceil(propRuns() * 0.3));

/** The first counterexample of `mask` against `oracle`, or null when every run agrees. */
function counterexample(
  mask: Mask,
  oracle: (text: string) => string,
  shape: fc.Arbitrary<string>,
): unknown {
  const details = fc.check(
    fc.property(anyText, shape, (text, shaped) =>
      [text, shaped].every((input) => run(mask, input) === oracle(input)),
    ),
    propParams(),
  );
  if (!details.failed) return null;
  const example = details.counterexample;
  return example === null
    ? { error: String(details.errorInstance) }
    : example.map((input) => ({ input, got: run(mask, input), want: oracle(input) }));
}

it(
  '[BR-ID-33 收款账号的脱敏格式] 任意字符串：支付宝登录号脱敏与契约一致（手机号 3+4、邮箱留前 2 / 1 / 0 位加 ***，其余全是 *）',
  () => {
    expect(counterexample(maskAlipayLogonId, oracleLogonId, logonShape)).toBeNull();
  },
  PROPERTY_TIMEOUT_MS,
);

it(
  '[BR-ID-33 收款账号的脱敏格式] 任意字符串：银行卡脱敏与契约一致（12～19 位 ASCII 数字为「尾号 后 4 位」，其余全是 *）',
  () => {
    expect(counterexample(maskBankCardTail, oracleCard, cardShape)).toBeNull();
  },
  PROPERTY_TIMEOUT_MS,
);

it(
  '[BR-ID-33 收款人姓名同姓名格式] 任意字符串：收款人姓名脱敏与姓名格式一致（只留末一个码点，单字全遮）',
  () => {
    expect(counterexample(maskPayeeName, oracleName, anyText)).toBeNull();
  },
  PROPERTY_TIMEOUT_MS,
);
