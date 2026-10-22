import { expect, it } from 'vitest';
import {
  formatPastTime,
  formatPlainDate,
  outcomeFor,
  outcomeOfResponse,
  parseClaimConfig,
  activeBlockMessage,
  claimCompareValue,
  claimMatches,
  LOCATE_MAX_PAGES,
  locateStep,
  msUntilNextShanghaiDay,
  recordView,
  type Claim,
} from './model.ts';

const NOW = Date.parse('2026-10-22T12:00:00+08:00');

it('[AC-F1-04b-UNIT#1] 纯日期同年省略年份、跨年保留；过去时间今天、昨天带时刻', () => {
  expect(formatPlainDate('2026-10-02', NOW)).toBe('10-02');
  expect(formatPlainDate('2025-12-29', NOW)).toBe('2025-12-29');
  expect(formatPastTime('2026-10-22T08:05:00+08:00', NOW)).toMatch(/08:05$/);
  expect(formatPastTime('2026-10-21T23:59:00+08:00', NOW)).toMatch(/23:59$/);
  expect(formatPastTime('2026-10-04T10:15:00+08:00', NOW)).toBe('10-04');
  expect(formatPastTime('2025-12-30T10:15:00+08:00', NOW)).toBe('2025-12-30');
});

it('[AC-F1-04b-UNIT#2] 配置解析：维护与未开放平台不显示，期限非正整数隐藏，指引只认对象', () => {
  const config = parseClaimConfig({
    features: { platform_status: { taobao: 'maintenance', jd: 'on', pdd: 'not_launched' } },
    claim: { window_days: 0 },
    help_links: {
      'claim_guide.jd': { route: 'Help', params: { article_id: 'a' } },
      'claim_guide.pdd': 'x',
    },
  });
  expect(config.platforms).toEqual(['jd']);
  expect(config.windowDays).toBeNull();
  expect(config.guides).toEqual({ jd: { route: 'Help', params: { article_id: 'a' } } });
});

it('[AC-F1-04b-UNIT#3] 错误码落位：付款因子不符在日期，20001 按字段，30203 与 30206 置灰', () => {
  expect(outcomeFor(30202, { reason: 'FACTOR_MISMATCH' })).toMatchObject({
    kind: 'inline',
    order: null,
  });
  expect(outcomeFor(30202, { reason: 'UNKNOWN' })).toMatchObject({ kind: 'inline', date: null });
  expect(outcomeFor(20001, { fields: ['paid_date'] })).toMatchObject({
    kind: 'inline',
    order: null,
  });
  expect(outcomeFor(20001, null)).toMatchObject({ kind: 'inline', date: null });
  expect(outcomeFor(30203, { reason: 'RISK_BLOCKED' }).kind).toBe('blocked');
  expect(outcomeFor(30206, null).kind).toBe('blocked');
  expect(outcomeFor(30205, null).kind).toBe('duplicate');
  expect(outcomeOfResponse('<html>').kind).toBe('general');
  expect(outcomeOfResponse({ code: 0, data: null }).kind).toBe('general');
});

it('[AC-F1-04b-UNIT#4] 多个子订单分行，未决定的子项是审核中', () => {
  const claim: Claim = {
    claim_id: 'c1',
    platform: 'meituan',
    order_no: '1',
    paid_date: '2026-10-01',
    status: 'manual_review',
    created_at: '2026-10-02T10:00:00+08:00',
    items: [
      { sub_order_id: 's1', decision: null, reject_reason: null },
      { sub_order_id: 's2', decision: 'rejected', reject_reason: 'FRAUD' },
    ],
  };
  const view = recordView(claim, NOW);
  expect(view.platform).toBeNull();
  expect(view.lines.map((line) => [line.subOrderId, line.state])).toEqual([
    ['s1', 'pending'],
    ['s2', 'rejected'],
  ]);
  expect(view.lines[1]?.text).not.toContain('FRAUD');
});

function pddClaim(orderNo: string, subOrderIds: string[]): Claim {
  return {
    claim_id: 'c-pdd',
    platform: 'pdd',
    order_no: orderNo,
    paid_date: '2026-10-06',
    status: 'manual_review',
    created_at: '2026-10-07T10:15:00+08:00',
    items: subOrderIds.map((id) => ({ sub_order_id: id, decision: null, reject_reason: null })),
  };
}

it('[AC-F1-04b-UNIT#5] 订单号比对与服务端一致：去空格，拼多多再去连字符，其余平台不去连字符', () => {
  expect(claimCompareValue('pdd', '231006-1234567890')).toBe('2310061234567890');
  expect(claimCompareValue('pdd', '2310 06-12345 67890')).toBe('2310061234567890');
  expect(claimCompareValue('taobao', '3712 3456-78')).toBe('37123456-78');
  const claim = pddClaim('231006-1234567890', ['231006-1234567890']);
  expect(claimMatches(claim, { platform: 'pdd', orderNo: '2310061234567890' })).toBe(true);
  expect(claimMatches(claim, { platform: 'pdd', orderNo: '231006 1234567890' })).toBe(true);
  expect(claimMatches(claim, { platform: 'jd', orderNo: '2310061234567890' })).toBe(false);
  expect(claimMatches(claim, { platform: 'pdd', orderNo: '2310061234567891' })).toBe(false);
  expect(claimMatches(claim, { claimId: 'c-pdd' })).toBe(true);
  expect(claimMatches(claim, { claimId: 'other' })).toBe(false);
  const taobao: Claim = { ...claim, platform: 'taobao', order_no: '12-34' };
  expect(claimMatches(taobao, { platform: 'taobao', orderNo: '1234' })).toBe(false);
  expect(claimMatches(taobao, { platform: 'taobao', orderNo: '12-34' })).toBe(true);
});

it('[AC-F1-04b-UNIT#6] 30205 用子订单号提交时也能对上已有申请', () => {
  const claim = pddClaim('260918-000000000000001', ['260918-111', '260918-222']);
  expect(claimMatches(claim, { platform: 'pdd', orderNo: '260918222' })).toBe(true);
  expect(claimMatches(claim, { platform: 'pdd', orderNo: '   ' })).toBe(false);
});

it('[AC-F1-04b-UNIT#7] 定位步骤：没找到且有下一页时继续取，到上限或下一页失败时保留目标，取完才结束', () => {
  const base = { found: false, hasNextPage: true, pagesLoaded: 1, nextPageFailed: false };
  expect(locateStep(base)).toBe('load');
  expect(locateStep({ ...base, found: true })).toBe('found');
  expect(locateStep({ ...base, pagesLoaded: LOCATE_MAX_PAGES })).toBe('wait');
  expect(locateStep({ ...base, nextPageFailed: true })).toBe('wait');
  expect(locateStep({ ...base, hasNextPage: false })).toBe('done');
  expect(locateStep({ ...base, pagesLoaded: LOCATE_MAX_PAGES + 3, found: true })).toBe('found');
});

it('[AC-F1-04b-UNIT#8] 当天置灰按上海日期：当天生效，上海次日 0 点起失效', () => {
  const block = { day: '2026-10-22', message: 'm' };
  expect(activeBlockMessage(block, Date.parse('2026-10-22T00:00:00+08:00'))).toBe('m');
  expect(activeBlockMessage(block, Date.parse('2026-10-22T23:59:59+08:00'))).toBe('m');
  expect(activeBlockMessage(block, Date.parse('2026-10-23T00:00:00+08:00'))).toBeNull();
  // UTC 已是 10-22 但上海已到 10-23。
  expect(activeBlockMessage(block, Date.parse('2026-10-22T16:00:00Z'))).toBeNull();
  expect(activeBlockMessage(null, NOW)).toBeNull();
  expect(msUntilNextShanghaiDay(Date.parse('2026-10-22T23:59:00+08:00'))).toBe(60_000);
  expect(msUntilNextShanghaiDay(Date.parse('2026-10-22T00:00:00+08:00'))).toBe(86_400_000);
});
