import { expect, it } from 'vitest';
import {
  claimCounts,
  claimMatches,
  evidenceLinks,
  isUuid,
  normalizeClaimQuery,
  type ClaimMatchOrder,
} from './admin-claim-view.ts';

it('[AC-B1-10j#15] q 去首尾空白与内部空格后 1～64 个字符，否则 null', () => {
  expect(normalizeClaimQuery('  PA RENT- EXACT  ')).toBe('PARENT-EXACT');
  expect(normalizeClaimQuery('\tA\n')).toBe('A');
  expect(normalizeClaimQuery('x'.repeat(64))).toBe('x'.repeat(64));
  expect(normalizeClaimQuery(` ${'x '.repeat(64)} `)).toBe('x'.repeat(64));
  expect(normalizeClaimQuery('')).toBeNull();
  expect(normalizeClaimQuery('   ')).toBeNull();
  expect(normalizeClaimQuery('x'.repeat(65))).toBeNull();
});

it('[AC-B1-10j#29] 六个状态计数含 0 与 submitted，未知状态视为库损坏', () => {
  expect(
    claimCounts([
      { status: 'submitted', n: 1 },
      { status: 'approved', n: 3 },
    ]),
  ).toEqual({
    submitted: 1,
    auto_matched: 0,
    manual_review: 0,
    approved: 3,
    rejected: 0,
    cancelled: 0,
  });
  expect(() => claimCounts([{ status: 'other', n: 1 }])).toThrow();
});

const order = (patch: Partial<ClaimMatchOrder> = {}): ClaimMatchOrder => ({
  sub_order_id: 'CHILD-1',
  parent_order_id: 'PARENT-1',
  is_presale: false,
  deposit_paid_at: null,
  paid_at: new Date('2026-10-05T16:30:00.000Z'),
  ...patch,
});

it('[AC-B1-10j#21] 父单比对父单号，付款日期按北京时间，预售取定金日期', () => {
  const claim = {
    platform: 'jd',
    order_no: 'PARENT-1',
    order_no_type: 'parent',
    paid_date: '2026-10-06',
  };
  expect(claimMatches(claim, order())).toEqual([
    { field: 'order_no', user_value: 'PARENT-1', union_value: 'PARENT-1', matched: true },
    { field: 'paid_date', user_value: '2026-10-06', union_value: '2026-10-06', matched: true },
  ]);
  const presale = order({
    is_presale: true,
    deposit_paid_at: new Date('2026-10-05T16:01:00.000Z'),
    paid_at: new Date('2026-10-07T03:00:00.000Z'),
  });
  expect(claimMatches(claim, presale)[1]).toEqual({
    field: 'paid_date',
    user_value: '2026-10-06',
    union_value: '2026-10-06',
    matched: true,
  });
  expect(claimMatches(claim, order({ is_presale: true, deposit_paid_at: null }))[1]).toMatchObject({
    union_value: null,
    matched: false,
  });
});

it('[AC-B1-10j#22] 子单比对子单号；不一致、缺失与无订单行都不算一致；pdd 去连字符比较', () => {
  const claim = {
    platform: 'jd',
    order_no: 'CHILD-1',
    order_no_type: 'sub',
    paid_date: '2026-10-06',
  };
  expect(claimMatches(claim, order({ parent_order_id: 'X' }))[0]).toMatchObject({
    union_value: 'CHILD-1',
    matched: true,
  });
  expect(claimMatches(claim, order({ sub_order_id: 'OTHER' }))[0]).toMatchObject({
    union_value: 'OTHER',
    matched: false,
  });
  expect(claimMatches(claim, order({ paid_at: new Date('2026-10-04T15:59:00.000Z') }))[1]).toEqual({
    field: 'paid_date',
    user_value: '2026-10-06',
    union_value: '2026-10-04',
    matched: false,
  });
  expect(claimMatches(claim, order({ paid_at: null }))[1]).toMatchObject({
    union_value: null,
    matched: false,
  });
  expect(
    claimMatches({ ...claim, order_no_type: 'parent' }, order({ parent_order_id: null }))[0],
  ).toMatchObject({ union_value: null, matched: false });
  expect(claimMatches(claim, null)).toEqual([
    { field: 'order_no', user_value: 'CHILD-1', union_value: null, matched: false },
    { field: 'paid_date', user_value: '2026-10-06', union_value: null, matched: false },
  ]);
  const pdd = { ...claim, platform: 'pdd', order_no: '231005-0987' };
  expect(claimMatches(pdd, order({ sub_order_id: '2310050987' }))[0]).toMatchObject({
    union_value: '2310050987',
    matched: true,
  });
});

it('[AC-B1-10j#20] 命中记录按时间倒序（同时间 id 大者先），保留空 scene，未知 scene 记为 null，查不到的 id 不出', () => {
  const moments = new Map([
    ['1', { at: new Date('2026-10-04T01:00:00.000Z'), scene: 'search' }],
    ['2', { at: new Date('2026-10-04T02:00:00.000Z'), scene: null }],
    ['3', { at: new Date('2026-10-05T01:00:00.000Z'), scene: 'detail' }],
    ['4', { at: new Date('2026-10-05T01:00:00.000Z'), scene: 'not-a-scene' }],
  ]);
  const scenes = new Set(['search', 'detail']);
  expect(evidenceLinks([1n, 3n, 2n, 4n, 9n, 1n], moments, scenes)).toEqual([
    { at: '2026-10-05T01:00:00.000Z', scene: null },
    { at: '2026-10-05T01:00:00.000Z', scene: 'detail' },
    { at: '2026-10-04T02:00:00.000Z', scene: null },
    { at: '2026-10-04T01:00:00.000Z', scene: 'search' },
  ]);
  expect(evidenceLinks(null, moments, scenes)).toEqual([]);
  expect(evidenceLinks([], moments, scenes)).toEqual([]);
});

it('[AC-B1-10j#17] isUuid 只认 8-4-4-4-12 位十六进制（不分大小写），其余一律不是', () => {
  expect(isUuid('019c0000-0000-7000-8000-0000000000c1')).toBe(true);
  expect(isUuid('019C0000-0000-7000-8000-0000000000C1')).toBe(true);
  for (const v of [
    '',
    'not-a-uuid',
    '019c0000-0000-7000-8000-0000000000c',
    '019c0000-0000-7000-8000-0000000000c1 ',
    '019c00000000700080000000000000c1',
    '019c0000-0000-7000-8000-0000000000g1',
  ]) {
    expect(isUuid(v)).toBe(false);
  }
});
