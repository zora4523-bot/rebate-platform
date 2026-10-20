import {
  classifySettlementBillOrder,
  splitSettlementBillBatches,
  type BillValidationResult,
} from '@couli/domain';
import { expect, it } from 'vitest';
import { classification, validated } from './fixtures.ts';

it('[AC-B2-04f#19] 按完整 order_key 字符串升序拆批，同平台每批不超过入参上限', () => {
  const input = ['2', '1', '20', '10', '3'].map((id) => validated('taobao', id));
  expect(splitSettlementBillBatches('2026-10', input, 2)).toEqual([
    {
      platform: 'taobao',
      bill_period: '2026-10',
      status: 'DRAFT',
      order_keys: ['taobao:1', 'taobao:10'],
    },
    {
      platform: 'taobao',
      bill_period: '2026-10',
      status: 'DRAFT',
      order_keys: ['taobao:2', 'taobao:20'],
    },
    { platform: 'taobao', bill_period: '2026-10', status: 'DRAFT', order_keys: ['taobao:3'] },
  ]);
});

it('[AC-B2-04f#20] 平台隔离，跨平台相同子订单号不丢失、不混批', () => {
  const result = splitSettlementBillBatches(
    '2026-10',
    [
      validated('taobao', '2'),
      validated('jd', '2'),
      validated('pdd', '1'),
      validated('taobao', '1'),
      validated('jd', '1'),
    ],
    2,
  );
  // 平台之间的输出顺序不属于业务要求；每个平台内部的批次及明细顺序必须稳定。
  expect([...result].sort((a, b) => a.platform.localeCompare(b.platform))).toEqual([
    { platform: 'jd', bill_period: '2026-10', status: 'DRAFT', order_keys: ['jd:1', 'jd:2'] },
    { platform: 'pdd', bill_period: '2026-10', status: 'DRAFT', order_keys: ['pdd:1'] },
    {
      platform: 'taobao',
      bill_period: '2026-10',
      status: 'DRAFT',
      order_keys: ['taobao:1', 'taobao:2'],
    },
  ]);
});

it.each([1, 2, 4999, 5000, 5001, 10000] as const)(
  '[AC-B2-04f#21] %s 单在默认配置 5000 下无遗漏、无重复、无空批',
  (count) => {
    const ascending = Array.from(
      { length: count },
      (_, i) => `taobao:${String(i + 1).padStart(5, '0')}`,
    );
    const input = [...ascending]
      .reverse()
      .map((key) => validated('taobao', '', { order_key: key }));
    const batches = splitSettlementBillBatches('2026-10', input, 5000);
    const lengths = new Map<number, number[]>([
      [1, [1]],
      [2, [2]],
      [4999, [4999]],
      [5000, [5000]],
      [5001, [5000, 1]],
      [10000, [5000, 5000]],
    ]);
    expect({
      lengths: batches.map((b) => b.order_keys.length),
      keys: batches.flatMap((b) => b.order_keys),
    }).toEqual({ lengths: lengths.get(count), keys: ascending });
  },
);

it('[AC-B2-04f#22] 非候选的五种结果与范围外都不得生成批次', () => {
  const excluded: readonly (BillValidationResult | null)[] = [
    'amount_mismatch',
    'deferred',
    'unexpected_settlement',
    'already_credited',
    'missing_settlement',
    null,
  ];
  const input = excluded.map((result, i) => validated('taobao', String(i), { result }));
  input.push(validated('taobao', 'ok'));
  expect(splitSettlementBillBatches('2026-10', input, 2)).toEqual([
    { platform: 'taobao', bill_period: '2026-10', status: 'DRAFT', order_keys: ['taobao:ok'] },
  ]);
});

it('[AC-B2-04f#23] 平台关闭仍保留校验结果，但不生成批次；开启后可纳入', () => {
  const result = classifySettlementBillOrder(classification());
  const disabled = validated('taobao', '1', { credit_enabled: false, result });
  expect({
    result,
    disabled: splitSettlementBillBatches('2026-10', [disabled], 5000),
    enabled: splitSettlementBillBatches('2026-10', [{ ...disabled, credit_enabled: true }], 5000),
  }).toEqual({
    result: 'candidate',
    disabled: [],
    enabled: [
      { platform: 'taobao', bill_period: '2026-10', status: 'DRAFT', order_keys: ['taobao:1'] },
    ],
  });
});

it('[AC-B2-04f#24] 一个平台关闭不阻止其他平台生成批次', () => {
  expect(
    splitSettlementBillBatches(
      '2026-10',
      [validated('jd', '1', { credit_enabled: false }), validated('taobao', '1')],
      5000,
    ),
  ).toEqual([
    { platform: 'taobao', bill_period: '2026-10', status: 'DRAFT', order_keys: ['taobao:1'] },
  ]);
});

it('[AC-B2-04f#25] 空候选列表不生成空批次', () => {
  expect(splitSettlementBillBatches('2026-10', [], 5000)).toEqual([]);
});

it('[AC-B2-04f#26] 上限 1 与自定义账单月原样生效', () => {
  expect(
    splitSettlementBillBatches('2027-01', [validated('taobao', '2'), validated('taobao', '1')], 1),
  ).toEqual([
    { platform: 'taobao', bill_period: '2027-01', status: 'DRAFT', order_keys: ['taobao:1'] },
    { platform: 'taobao', bill_period: '2027-01', status: 'DRAFT', order_keys: ['taobao:2'] },
  ]);
});

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  '[AC-B2-04f#27] 非正整数批次上限 %s 必须拒绝，避免循环或静默丢单',
  (limit) => {
    expect(() => splitSettlementBillBatches('2026-10', [validated('taobao', '1')], limit)).toThrow(
      RangeError,
    );
  },
);

it('[AC-B2-04f#28] 拆批不原地排序输入，乱序重放产生相同分组', () => {
  const input = Object.freeze([
    Object.freeze(validated('taobao', '2')),
    Object.freeze(validated('taobao', '10')),
    Object.freeze(validated('taobao', '1')),
  ]);
  const before = structuredClone(input);
  const result = splitSettlementBillBatches('2026-10', input, 2);
  expect({ result, input }).toEqual({
    result: splitSettlementBillBatches('2026-10', [...input].reverse(), 2),
    input: before,
  });
});
