import { expect, expectTypeOf, it, vi } from 'vitest';
import type { AgentRedactor as HttpAgentRedactor } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type { RedactedText as AdmissionRedactedText } from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import type { RedactedText as DegradedRedactedText } from '../../../../apps/api/src/modules/agent/model-gateway/degraded/index.ts';
import {
  createAgentRedactor,
  maskForTrace,
  redactForModel,
  restorePlaceholders,
  type AgentRedactedText,
  type PlaceholderTable,
} from '../../../../apps/api/src/modules/agent/preprocess/redact/index.ts';
import { findCandidateSpans } from '../../../../apps/api/src/modules/parsing/index.ts';

// BR-AI-14 / BR-AI-19：掩码样式未限定，只核对保留部分和原文不泄漏。
const TABLE: PlaceholderTable = Object.freeze({
  '<num_1>': '3812345678901234567',
  '<num_2>': '28000000001',
});

it('[AC-B3-05a#14][BR-AI-14] 工具参数嵌套对象与数组还原为副本，不修改参数和占位表', () => {
  const input = Object.freeze({
    order_no: '<num_1>',
    nested: Object.freeze([
      Object.freeze({ item_id: '<num_2>', repeated: '<num_1>' }),
      Object.freeze({ untouched: Object.freeze(['合成', 7, null, true]) }),
    ] as const),
  });
  const result = restorePlaceholders(input, TABLE);
  expect(result).toEqual({
    order_no: '3812345678901234567',
    nested: [
      { item_id: '28000000001', repeated: '3812345678901234567' },
      { untouched: ['合成', 7, null, true] },
    ],
  });
  expect(result).not.toBe(input);
  const copy = result as typeof input;
  expect(copy.nested).not.toBe(input.nested);
  expect(copy.nested[0]).not.toBe(input.nested[0]);
  expect(copy.nested[1]).not.toBe(input.nested[1]);
  expect(copy.nested[1]?.untouched).not.toBe(input.nested[1]?.untouched);
  expect(input.order_no).toBe('<num_1>');
  expect(input.nested[0]?.item_id).toBe('<num_2>');
  expect(TABLE).toEqual({ '<num_1>': '3812345678901234567', '<num_2>': '28000000001' });
});

it.each([
  '<num_1>x',
  'x<num_1>',
  '订单 <num_1>',
  ' <num_1> ',
  '<num_1><num_2>',
  '<num_999>',
  '<num_01>',
  '<NUM_1>',
  '',
])('[AC-B3-05a#15][BR-AI-14] 非完整记号或未知编号 %s 原样保留', (value) => {
  expect(restorePlaceholders(value, TABLE)).toBe(value);
});

it.each([null, false, true, 0, 7])(
  '[AC-B3-05a#16][BR-AI-14] 工具参数非字符串标量 %s 保持原类型与值',
  (value) => {
    expect(restorePlaceholders(value, TABLE)).toBe(value);
  },
);

it('[AC-B3-05a#17][BR-AI-14] 仅还原参数值，不把参数键解释为占位符', () => {
  expect(restorePlaceholders({ '<num_1>': '<num_2>' }, TABLE)).toEqual({
    '<num_1>': '28000000001',
  });
});

it('[AC-B3-05a#18][BR-AI-14][BR-AI-19] 同一长数字模型用占位符、存储只保留后四位', async () => {
  const raw = '3812345678901234567';
  const model = redactForModel(raw);
  const stored = await createAgentRedactor().redact('synthetic-app-a', raw);
  expect(model).toEqual({ text: '<num_1>', placeholders: { '<num_1>': raw } });
  expect(stored).toMatch(/^[^0-9]+4567$/);
  expect(stored).not.toContain('<num_');
  expect(stored).not.toContain(raw);
  expect(maskForTrace(raw)).toBe(stored);
});

it.each([
  ['13800000000', /^138[^0-9]+0000$/],
  ['990101199001010019', /^[^0-9]+0019$/],
  ['99010119900101006X', /^[^0-9]+006X$/],
  ['990101199001010018', /^[^0-9]+0018$/],
  ['38123456789', /^[^0-9]+6789$/],
  ['3812345678901234567', /^[^0-9]+4567$/],
  ['synthetic@example.invalid', /^s[^A-Za-z0-9@]*@example\.invalid$/],
] as const)(
  '[AC-B3-05a#19][BR-AI-14][BR-AI-19] user_text 与工具参数对 %s 使用相同存储口径',
  async (raw, pattern) => {
    const stored = await createAgentRedactor().redact('synthetic-app-a', raw);
    expect(stored).toMatch(pattern);
    expect(stored).not.toContain(raw);
    expect(stored).not.toContain('synthetic@');
    expect(maskForTrace(raw)).toBe(stored);
    expect(stored).not.toContain('<num_');
  },
);

it('[AC-B3-05a#20][BR-AI-14][BR-AI-19] 收货地址在两个存储入口均只保留省市', async () => {
  const raw = '寄到广东省深圳市南山区合成路88号101室。谢谢';
  const stored = await createAgentRedactor().redact('synthetic-app-a', raw);
  expect(stored).toContain('寄到广东省深圳市');
  expect(stored).toMatch(/谢谢$/);
  expect(stored).not.toMatch(/南山区|合成路|88|101/);
  expect(maskForTrace(raw)).toBe(stored);
});

it('[AC-B3-05a#21][BR-AI-19] trace 深层自由文本与数组统一脱敏，保留结构且不修改输入', () => {
  const input = Object.freeze({
    order_no: '3812345678901234567',
    nested: Object.freeze([
      Object.freeze({ note: '联系 13800000000', email: 'synthetic@example.invalid' }),
      Object.freeze(['28000000001', '合成人物张三', 7, false, null]),
    ]),
  });
  const result = maskForTrace(input);
  expect(result).toEqual({
    order_no: expect.stringMatching(/^[^0-9]+4567$/),
    nested: [
      {
        note: expect.stringMatching(/^联系 138[^0-9]+0000$/),
        email: expect.stringMatching(/^s[^A-Za-z0-9@]*@example\.invalid$/),
      },
      [expect.stringMatching(/^[^0-9]+0001$/), '合成人物张三', 7, false, null],
    ],
  });
  expect(result).not.toBe(input);
  const copy = result as typeof input;
  expect(copy.nested).not.toBe(input.nested);
  expect(copy.nested[0]).not.toBe(input.nested[0]);
  expect(copy.nested[1]).not.toBe(input.nested[1]);
  expect(input).toEqual({
    order_no: '3812345678901234567',
    nested: [
      { note: '联系 13800000000', email: 'synthetic@example.invalid' },
      ['28000000001', '合成人物张三', 7, false, null],
    ],
  });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toMatch(/\d{11,}|<num_|synthetic@/);
});

it('[AC-B3-05a#22][BR-AI-14][BR-AI-19] 参数还原用于执行后，trace 再遮盖原始长数字', () => {
  const restored = restorePlaceholders({ order_no: '<num_1>' }, TABLE);
  expect(restored).toEqual({ order_no: '3812345678901234567' });
  expect(maskForTrace(restored)).toEqual({ order_no: expect.stringMatching(/^[^0-9]+4567$/) });
  expect(restored).toEqual({ order_no: '3812345678901234567' });
});

it('[AC-B3-05a#23][BR-AI-14][BR-AI-19] 全部链接与口令在存储形态保留原文及其内部数字', async () => {
  const raw =
    '合成 https://example.invalid/90000000001 https://example.invalid/90000000002 ' +
    '￥Ab3812345678901234567￥ https://example.invalid/90000000004 ' +
    'https://example.invalid/90000000005?phone=13800000000';
  expect(await createAgentRedactor().redact('synthetic-app-a', raw)).toBe(raw);
  expect(maskForTrace({ url_and_password: raw })).toEqual({ url_and_password: raw });
});

it('[AC-B3-05a#24][BR-AI-14][BR-AI-19] 存储文本和嵌套 trace 再脱敏保持不变', async () => {
  const redactor = createAgentRedactor();
  const raw =
    '13800000000 99010119900101006X synthetic@example.invalid ' +
    '广东省深圳市南山区合成路88号101室 3812345678901234567';
  const first = await redactor.redact('synthetic-app-a', raw);
  expect(await redactor.redact('synthetic-app-a', first)).toBe(first);
  const trace = maskForTrace({ nested: [raw] });
  expect(maskForTrace(trace)).toEqual(trace);
});

it('[AC-B3-05a#25][BR-AI-19] 返回值兼容两个文本品牌与 HTTP AgentRedactor 端口', async () => {
  expectTypeOf<AgentRedactedText>().toEqualTypeOf<AdmissionRedactedText & DegradedRedactedText>();
  expectTypeOf<string>().not.toExtend<AgentRedactedText>();
  const redactor = createAgentRedactor();
  expectTypeOf(redactor).toExtend<HttpAgentRedactor>();
  const stored = await redactor.redact('synthetic-app-a', '合成耳机');
  const model = redactForModel('合成耳机').text;
  expectTypeOf(stored).toEqualTypeOf<AgentRedactedText>();
  expectTypeOf(model).toEqualTypeOf<AgentRedactedText>();
  const admission: AdmissionRedactedText = stored;
  const degraded: DegradedRedactedText = model;
  expect(admission).toBe('合成耳机');
  expect(degraded).toBe('合成耳机');
});

it('[AC-B3-05a#26][BR-AI-19] 相同输入重复与交错调用确定，不读宿主时钟', async () => {
  const now = vi.spyOn(Date, 'now').mockImplementation(() => {
    throw new Error('不应读取时钟');
  });
  try {
    const redactor = createAgentRedactor();
    const raw = '合成订单 3812345678901234567';
    const first = await redactor.redact('synthetic-app-a', raw);
    await redactor.redact('synthetic-app-b', '28000000001');
    const second = await redactor.redact('synthetic-app-a', raw);
    expect(second).toBe(first);
    expect(await createAgentRedactor().redact('synthetic-app-a', raw)).toBe(first);
    expect(first).toMatch(/^合成订单 [^0-9]+4567$/);
    expect(now).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
  }
});

it.each([
  ['电话13800000000', /^，电话138[^0-9]+0000$/],
  ['订单3812345678901234567', /^，订单[^0-9]+4567$/],
] as const)(
  '[AC-B3-05a#37][BR-AI-14][BR-AI-19] 存储只豁免候选链接，中文标点后的 %s 仍脱敏',
  async (suffix, pattern) => {
    const link = 'https://example.invalid/90000000001';
    const input = `链接${link}，${suffix}`;
    expect(findCandidateSpans(input)).toEqual([{ kind: 'url', raw: link, index: 2 }]);
    const stored = await createAgentRedactor().redact('synthetic-app-a', input);
    expect(stored.slice(0, 2 + link.length)).toBe(`链接${link}`);
    expect(stored.slice(2 + link.length)).toMatch(pattern);
    expect(stored).not.toContain(suffix);
    expect(stored).not.toContain('<num_');
    expect(maskForTrace({ note: input })).toEqual({ note: stored });
  },
);
