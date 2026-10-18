import { expect, it } from 'vitest';
import {
  classifyTemplate,
  classifyTextKey,
} from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import type { FundTermKeys } from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import { isFundTermKey } from '../../../../packages/contracts-ts/scripts/fund-term-keys.ts';
import { defaults, fundTermKeys } from './fixtures.ts';

it.each([
  ['order_status.X', 'fund_terms'],
  ['tag.rebate', 'fund_terms'],
  ['privacy.basic_mode.notice', 'agreement'],
  ['perm.push.card_hint', 'agreement'],
  ['btn.buy', 'general'],
  ['btn.buy.coupon', 'general'],
  ['btn.buy.no_rebate', 'fund_terms'],
  ['unlisted.key', 'fund_terms'],
  ['btn.buy.unknown', 'fund_terms'],
  ['privacy', 'fund_terms'],
  ['permission.push', 'fund_terms'],
  ['PRIVACY.basic_mode.notice', 'fund_terms'],
] as const)('[AC-F1-02r#17] 文案键由同一清单分类：%s', (key, expected) => {
  expect(classifyTextKey(key, fundTermKeys)).toBe(expected);
});

it.each(Object.keys(defaults))('[AC-F1-02r#18] 默认文案资金归类与 CI 一致：%s', (key) => {
  const classification = classifyTextKey(key, fundTermKeys);
  expect(classification === 'fund_terms').toBe(isFundTermKey(fundTermKeys, key));
  expect(classification).toBe(
    isFundTermKey(fundTermKeys, key)
      ? 'fund_terms'
      : key.startsWith('privacy.') || key.startsWith('perm.')
        ? 'agreement'
        : 'general',
  );
});

it('[AC-F1-02r#19] 前缀按 startsWith 匹配，单列键整键相等，双重归类优先资金', () => {
  const custom: FundTermKeys = {
    fund_terms: {
      prefixes: ['error.303'],
      keys: ['privacy.shared', 'overlap'],
      notify_templates: [],
    },
    ordinary: {
      prefixes: ['privacy.', 'error.'],
      keys: ['perm.single', 'btn.buy', 'overlap', 'privacy', 'permission.push', 'xprivacy.notice'],
      notify_templates: [],
    },
    exempt: [],
  };
  for (const [key, expected] of [
    ['error.30301.x', 'fund_terms'],
    ['error.30401.x', 'general'],
    ['privacy.shared', 'fund_terms'],
    ['privacy.other', 'agreement'],
    ['perm.single', 'agreement'],
    ['perm.unlisted', 'fund_terms'],
    ['overlap', 'fund_terms'],
    ['btn.buy', 'general'],
    ['btn.buy.extra', 'fund_terms'],
    ['privacy', 'general'],
    ['permission.push', 'general'],
    ['xprivacy.notice', 'general'],
  ] as const) {
    expect(classifyTextKey(key, custom), key).toBe(expected);
  }
});

it('[AC-F1-02r#20] 协议前缀和 exempt 不替代清单归类', () => {
  const empty: FundTermKeys = {
    fund_terms: { prefixes: [], keys: [], notify_templates: [] },
    ordinary: { prefixes: [], keys: [], notify_templates: [] },
    exempt: [{ key: 'privacy.notice', reason: '仅供关键词核对' }],
  };
  expect(classifyTextKey('privacy.notice', empty)).toBe('fund_terms');
  expect(classifyTextKey('perm.notice', empty)).toBe('fund_terms');
  expect(classifyTextKey('btn.buy', empty)).toBe('fund_terms');
});

it.each([
  ['CREDITED', 'fund_terms'],
  ['SMS_CODE', 'general'],
  ['UNKNOWN', 'fund_terms'],
  ['SMS_CODE.extra', 'fund_terms'],
  ['sms_code', 'fund_terms'],
] as const)('[AC-F1-02r#21] 通知模板按编码整值分类：%s', (code, expected) => {
  expect(classifyTemplate(code, fundTermKeys)).toBe(expected);
});

it('[AC-F1-02r#22] 通知只查模板列表，双重命中按资金处理且不修改清单', () => {
  const custom: FundTermKeys = {
    fund_terms: { prefixes: [], keys: [], notify_templates: ['BOTH'] },
    ordinary: { prefixes: ['KEY_'], keys: ['KEY_ONLY'], notify_templates: ['BOTH', 'NORMAL'] },
    exempt: [],
  };
  const before = structuredClone(custom);
  expect(classifyTemplate('BOTH', custom)).toBe('fund_terms');
  expect(classifyTemplate('KEY_ONLY', custom)).toBe('fund_terms');
  expect(classifyTemplate('NORMAL', custom)).toBe('general');
  expect(classifyTextKey('NORMAL', custom)).toBe('fund_terms');
  expect(classifyTextKey('KEY_ONLY', custom)).toBe('general');
  expect(custom).toEqual(before);
});
