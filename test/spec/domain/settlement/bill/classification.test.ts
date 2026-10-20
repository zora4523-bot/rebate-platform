import { classifySettlementBillOrder, type BillValidationResult } from '@couli/domain';
import { expect, it } from 'vitest';
import { classification, order, settlement } from './fixtures.ts';

// BR-FUND-04 ③④及细则「校验结果」：六种结果互斥，范围外另为 null。
it('[AC-B2-04f#1] 六种业务场景各返回唯一结果，未入账与已入账不混入候选', () => {
  const inputs = [
    classification(),
    classification({ settlement: settlement({ b_settle_fen: 799n }) }),
    classification({ order: order({ hold: true }) }),
    classification({ order: order({ rebate_status: 'ESTIMATED', settle_period: null }) }),
    classification({ order: order({ rebate_status: 'CREDITED' }) }),
    classification({ settlement: null }),
  ];
  expect(inputs.map(classifySettlementBillOrder)).toEqual([
    'candidate',
    'amount_mismatch',
    'deferred',
    'unexpected_settlement',
    'already_credited',
    'missing_settlement',
  ]);
});

it.each([
  ['2026-09', true, 'candidate'],
  ['2026-10', true, 'candidate'],
  ['2026-11', true, null],
  ['2026-09', false, null],
  ['2026-10', false, 'missing_settlement'],
  ['2026-11', false, null],
] as const)('[AC-B2-04f#2] 范围：收货月 %s、有数据 %s → %s', (period, hasData, expected) => {
  expect(
    classifySettlementBillOrder(
      classification({
        order: order({ settle_period: period }),
        settlement: hasData ? settlement() : null,
      }),
    ),
  ).toBe(expected);
});

it.each([
  ['2026-11-23T16:00:59.999Z', 'candidate'],
  ['2026-11-23T16:01:00.000Z', 'candidate'],
  ['2026-11-23T16:01:00.001Z', 'missing_settlement'],
] as const)('[AC-B2-04f#3] 生成开始截点按我方取得数据时刻 %s 判定', (createdAt, expected) => {
  expect(
    classifySettlementBillOrder(
      classification({
        settlement: settlement({ created_at: new Date(createdAt) }),
      }),
    ),
  ).toBe(expected);
});

it('[AC-B2-04f#4] 上期晚到数据不混入旧截点，补充校验及下期账单可以纳入同一收货月', () => {
  const late = settlement({ created_at: new Date('2026-12-02T10:00:00+08:00') });
  expect([
    classifySettlementBillOrder(classification({ settlement: late })),
    classifySettlementBillOrder(
      classification({
        settlement: late,
        generation_started_at: new Date('2026-12-02T11:00:00+08:00'),
      }),
    ),
    classifySettlementBillOrder(
      classification({
        settlement: late,
        bill_period: '2026-11',
        generation_started_at: new Date('2026-12-24T00:01:00+08:00'),
      }),
    ),
  ]).toEqual(['missing_settlement', 'candidate', 'candidate']);
});

it.each(['API', 'STATEMENT'] as const)(
  '[AC-B2-04f#5] 来源 %s 都比较换算后的 B，不把联盟佣金 N 当作 B',
  (source) => {
    expect(
      classifySettlementBillOrder(classification({ settlement: settlement({ source }) })),
    ).toBe('candidate');
  },
);

it.each([
  [800n, 0n, 'candidate'],
  [799n, 0n, 'amount_mismatch'],
  [801n, 0n, 'amount_mismatch'],
  [798n, 2n, 'candidate'],
  [802n, 2n, 'candidate'],
  [797n, 2n, 'amount_mismatch'],
  [803n, 2n, 'amount_mismatch'],
] as const)('[AC-B2-04f#6] 基数 %s、容差 %s：绝对差含边界 → %s', (base, tolerance, expected) => {
  expect(
    classifySettlementBillOrder(
      classification({
        settlement: settlement({ b_settle_fen: base }),
        match_tolerance_fen: tolerance,
      }),
    ),
  ).toBe(expected);
});

it('[AC-B2-04f#7] 大额的一分差不能经 number 转换而被抹平', () => {
  expect(
    classifySettlementBillOrder(
      classification({
        order: order({ snapshots: [{ commission_version: 1, base_fen: 9007199254740992n }] }),
        settlement: settlement({
          settle_commission_fen: 9007199254740993n,
          b_settle_fen: 9007199254740993n,
        }),
      }),
    ),
  ).toBe('amount_mismatch');
});

it('[AC-B2-04f#8] 零结算佣金是已有数据，零基数一致仍可进入候选', () => {
  expect(
    classifySettlementBillOrder(
      classification({
        order: order({ snapshots: [{ commission_version: 1, base_fen: 0n }] }),
        settlement: settlement({ settle_commission_fen: 0n, b_settle_fen: 0n }),
      }),
    ),
  ).toBe('candidate');
});

it.each([
  [
    { commission_version: 10, base_fen: 800n },
    { commission_version: 2, base_fen: 1000n },
    { commission_version: 9, base_fen: 999n },
  ],
  [
    { commission_version: 2, base_fen: 1000n },
    { commission_version: 10, base_fen: 800n },
    { commission_version: 9, base_fen: 999n },
  ],
])('[AC-B2-04f#9] 当前快照取最大数字版本，不取数组首尾或最大金额（排列 %#）', (...snapshots) => {
  expect(classifySettlementBillOrder(classification({ order: order({ snapshots }) }))).toBe(
    'candidate',
  );
});

it('[AC-B2-04f#10] 旧快照恰好匹配不能掩盖当前版本的金额差异', () => {
  expect(
    classifySettlementBillOrder(
      classification({
        order: order({
          snapshots: [
            { commission_version: 1, base_fen: 800n },
            { commission_version: 2, base_fen: 900n },
          ],
        }),
      }),
    ),
  ).toBe('amount_mismatch');
});

it.each([
  [true, false],
  [false, true],
  [true, true],
] as const)('[AC-B2-04f#11] hold=%s、维权=%s 时金额差异和缺结算均只记暂缓', (hold, rights) => {
  const paused = order({ hold, rights_pending: rights });
  expect([
    classifySettlementBillOrder(classification({ order: paused })),
    classifySettlementBillOrder(
      classification({ order: paused, settlement: settlement({ b_settle_fen: 1n }) }),
    ),
    classifySettlementBillOrder(classification({ order: paused, settlement: null })),
  ]).toEqual(['deferred', 'deferred', 'deferred']);
});

it('[AC-B2-04f#12] 以联盟为准仅豁免金额差异，不豁免暂缓、缺数据或范围', () => {
  const accepted = order({ union_authoritative: true });
  expect([
    classifySettlementBillOrder(
      classification({ order: accepted, settlement: settlement({ b_settle_fen: 1n }) }),
    ),
    classifySettlementBillOrder(classification({ order: { ...accepted, hold: true } })),
    classifySettlementBillOrder(classification({ order: { ...accepted, rights_pending: true } })),
    classifySettlementBillOrder(classification({ order: accepted, settlement: null })),
    classifySettlementBillOrder(
      classification({ order: { ...accepted, settle_period: '2026-11' } }),
    ),
  ]).toEqual(['candidate', 'deferred', 'deferred', 'missing_settlement', null]);
});

it.each(['ESTIMATED', 'VOID', 'CLAWED_BACK'] as const)(
  '[AC-B2-04f#13] 联盟数据对应 %s 只返回异常，不因以联盟为准而入账',
  (status) => {
    expect(
      classifySettlementBillOrder(
        classification({
          order: order({
            rebate_status: status,
            settle_period: null,
            union_authoritative: true,
          }),
        }),
      ),
    ).toBe('unexpected_settlement');
  },
);

it.each(['ESTIMATED', 'VOID', 'CLAWED_BACK', 'CREDITED'] as const)(
  '[AC-B2-04f#52] %s 缺少联盟结算数据时不生成应结未结差错',
  (status) => {
    expect(
      classifySettlementBillOrder(
        classification({
          order: order({ rebate_status: status }),
          settlement: null,
        }),
      ),
    ).toBeNull();
  },
);

it('[AC-B2-04f#14] 上传备用有数据而我方无单是异常；无双方数据不造差错', () => {
  expect([
    classifySettlementBillOrder(
      classification({ order: null, settlement: settlement({ source: 'STATEMENT' }) }),
    ),
    classifySettlementBillOrder(classification({ order: null, settlement: null })),
  ]).toEqual(['unexpected_settlement', null]);
});

it('[AC-B2-04f#15] 已入账的金额变化交补差，不返回金额差错或新候选', () => {
  expect(
    classifySettlementBillOrder(
      classification({
        order: order({ rebate_status: 'CREDITED', rights_pending: true }),
        settlement: settlement({ b_settle_fen: 700n }),
      }),
    ),
  ).toBe('already_credited');
});

it('[AC-B2-04f#16] 月份、金额与暂停组合的手算矩阵保证结果互斥', () => {
  const actual: (BillValidationResult | null)[] = [];
  for (const period of ['2026-09', '2026-10', '2026-11']) {
    for (const data of [null, settlement(), settlement({ b_settle_fen: 799n })]) {
      for (const flags of [
        { hold: false, rights_pending: false },
        { hold: true, rights_pending: false },
        { hold: false, rights_pending: true },
        { hold: true, rights_pending: true },
      ]) {
        actual.push(
          classifySettlementBillOrder(
            classification({ order: order({ settle_period: period, ...flags }), settlement: data }),
          ),
        );
      }
    }
  }
  expect(actual).toEqual([
    null,
    null,
    null,
    null,
    'candidate',
    'deferred',
    'deferred',
    'deferred',
    'amount_mismatch',
    'deferred',
    'deferred',
    'deferred',
    'missing_settlement',
    'deferred',
    'deferred',
    'deferred',
    'candidate',
    'deferred',
    'deferred',
    'deferred',
    'amount_mismatch',
    'deferred',
    'deferred',
    'deferred',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
});

it('[AC-B2-04f#17] 缺失当前快照的坏数据必须拒绝，不能按零或任意金额通过', () => {
  expect(() =>
    classifySettlementBillOrder(classification({ order: order({ snapshots: [] }) })),
  ).toThrow(RangeError);
});

it('[AC-B2-04f#18] 校验不修改输入快照顺序、状态和时间，重放给相同结果', () => {
  const snapshots = Object.freeze([
    Object.freeze({ commission_version: 2, base_fen: 800n }),
    Object.freeze({ commission_version: 1, base_fen: 900n }),
  ]);
  const input = Object.freeze(classification({ order: Object.freeze(order({ snapshots })) }));
  const before = structuredClone(input);
  const first = classifySettlementBillOrder(input);
  expect({ first, again: classifySettlementBillOrder(input), input }).toEqual({
    first: 'candidate',
    again: 'candidate',
    input: before,
  });
});
