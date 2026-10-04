// specs/fund-term-keys.yaml (08 BR-TEXT-12 细则「资金术语键」) and its check (CT-19b).
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { loadEnums } from './catalog.ts';
import {
  checkFundTermDoc,
  checkFundTermKeys,
  type FundTermKeys,
  isFundTermKey,
  keywordHits,
  loadFundTermKeys,
  segmentsOfKey,
  segmentsOfTemplate,
} from './fund-term-keys.ts';
import { textsFile } from './texts.ts';

const enums = loadEnums();
const codes =
  enums.find((e) => e.name === 'notify_template_code')?.values.map((v) => v.value) ?? [];
const texts = (JSON.parse(readFileSync(textsFile, 'utf8')) as { texts: Record<string, string> })
  .texts;
const doc = loadFundTermKeys() as FundTermKeys;

function base(): FundTermKeys {
  return {
    fund_terms: { prefixes: ['withdraw.'], keys: ['tag.rebate'], notify_templates: ['CREDITED'] },
    ordinary: { prefixes: ['perm.'], keys: ['btn.buy'], notify_templates: ['SMS_CODE'] },
    exempt: [],
  };
}
const smallTexts = {
  'withdraw.all': '全部提现',
  'perm.go_settings': '去设置',
  'btn.buy': '去购买',
};
const smallCodes = ['CREDITED', 'SMS_CODE'];

it('the committed list passes the check', () => {
  expect(checkFundTermKeys(enums)).toEqual([]);
});

it('every text key and notify template falls in exactly one segment', () => {
  for (const key of Object.keys(texts)) expect(segmentsOfKey(doc, key), key).toHaveLength(1);
  for (const code of codes) expect(segmentsOfTemplate(doc, code), code).toHaveLength(1);
});

it('classifies the keys 08 names', () => {
  const fund = [
    'withdraw.all',
    'withdraw_detail.copy',
    'ledger.balance_after',
    'external_page.product_unresolved',
    'error.30301',
    'error.30303.below_min',
    'error.30202.ORDER_INVALID',
    'order_status.CREDITED.summary',
    'order_status_group.no_rebate',
    'order_list.deposit_amount',
    'earnings.metric.est.name_self',
    'pending_confirm.withdraw.desc',
    'error.44001',
    'platform_coming_soon',
  ];
  for (const k of fund) expect(segmentsOfKey(doc, k), k).toEqual(['fund_terms']);
  const ordinary = [
    'external_page.load_failed',
    'external_page.retry',
    'external_page.close',
    'error.30101',
    'error.30111',
    'error.30131',
    'clipboard.prompt',
    'claim.guide.entry',
    'app_update.unavailable',
    'order_timeline.deposit_paid',
    'pending_confirm.abandon',
    'agent.notice.search_disabled',
    'no_rebate.price_compare.similar',
  ];
  for (const k of ordinary) expect(segmentsOfKey(doc, k), k).toEqual(['ordinary']);
  expect(doc.ordinary.prefixes).not.toContain('external_page.');
  expect(doc.fund_terms.notify_templates).toEqual(
    expect.arrayContaining([
      'WD_OVERDUE',
      'BALANCE_ADJUSTED',
      'RISK_STATE_CHANGED',
      'APPEAL_RESULT',
    ]),
  );
  expect([...doc.ordinary.notify_templates].sort()).toEqual([
    'SMS_CODE',
    'UNION_AUTH_EXPIRED',
    'UNION_AUTH_EXPIRING',
  ]);
});

it('the guard treats an unclassified key as a fund term', () => {
  expect(isFundTermKey(doc, 'no_such.key')).toBe(true);
  expect(isFundTermKey(doc, 'withdraw.all')).toBe(true);
  expect(isFundTermKey(doc, 'btn.buy')).toBe(false);
});

it('keyword cross-check', () => {
  expect(keywordHits('已付定金 {amount}')).toEqual(['{amount}']);
  expect(keywordHits('链接已失效')).toEqual(['已失效']);
  expect(keywordHits('查返利？')).toEqual(['返利']);
  expect(keywordHits('去设置')).toEqual([]);
  expect(keywordHits('共 {n} 件')).toEqual([]);
});

it('accepts a minimal well-formed list', () => {
  expect(checkFundTermDoc(base(), smallTexts, smallCodes)).toEqual([]);
});

it('fails on an unclassified text key or template', () => {
  expect(checkFundTermDoc(base(), { ...smallTexts, 'share.copied': '已复制' }, smallCodes)).toEqual(
    [expect.stringContaining('text key share.copied is not classified')],
  );
  expect(checkFundTermDoc(base(), smallTexts, [...smallCodes, 'WD_FAILED'])).toEqual([
    expect.stringContaining('notify template WD_FAILED is not classified'),
  ]);
});

it('fails when the two segments overlap', () => {
  const d = base();
  d.ordinary.prefixes.push('withdraw.est');
  expect(checkFundTermDoc(d, smallTexts, smallCodes).join('\n')).toMatch(/prefix .* overlap/);
  const e = base();
  e.ordinary.keys.push('withdraw.all');
  const p = checkFundTermDoc(e, smallTexts, smallCodes).join('\n');
  expect(p).toMatch(/withdraw\.all is covered by both segments/);
  expect(p).toMatch(/text key withdraw\.all is in both segments/);
  const f = base();
  f.ordinary.notify_templates.push('CREDITED');
  expect(checkFundTermDoc(f, smallTexts, smallCodes).join('\n')).toMatch(
    /CREDITED is in both segments/,
  );
});

it('fails on an unknown template code, a duplicate or a malformed entry', () => {
  const d = base();
  d.fund_terms.notify_templates.push('NOPE');
  d.fund_terms.keys.push('tag.rebate');
  d.ordinary.prefixes.push('Bad prefix');
  const p = checkFundTermDoc(d, smallTexts, smallCodes).join('\n');
  expect(p).toMatch(/duplicate tag\.rebate/);
  expect(p).toMatch(/"Bad prefix" is malformed/);
});

it('requires an exempt reason for an ordinary text that hits the cross-check', () => {
  const t = { ...smallTexts, 'btn.buy': '去购买，查返利' };
  expect(checkFundTermDoc(base(), t, smallCodes)).toEqual([
    expect.stringContaining('btn.buy is ordinary but its text hits 返利'),
  ]);
  const d = base();
  d.exempt.push({ key: 'btn.buy', reason: '只是请用户去查' });
  expect(checkFundTermDoc(d, t, smallCodes)).toEqual([]);
  d.exempt[0] = { key: 'btn.buy', reason: ' ' };
  expect(checkFundTermDoc(d, t, smallCodes).join('\n')).toMatch(/reason must be a non-empty/);
});

it('exempt only holds ordinary keys that hit the cross-check', () => {
  const d = base();
  d.exempt.push({ key: 'perm.go_settings', reason: 'x' }, { key: 'withdraw.all', reason: 'x' });
  const p = checkFundTermDoc(d, smallTexts, smallCodes).join('\n');
  expect(p).toMatch(/perm\.go_settings does not hit the keyword cross-check/);
  expect(p).toMatch(/withdraw\.all is not classified ordinary/);
});
