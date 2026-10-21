import { expect, it } from 'vitest';
import {
  formatPastTime,
  formatPlainDate,
  outcomeFor,
  outcomeOfResponse,
  parseClaimConfig,
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
