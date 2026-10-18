import { expect, it } from 'vitest';
import {
  checkTextVariables,
  classifyTemplate,
  classifyTextKey,
  findBannedWords,
  normalizeForMatch,
  type BannedWord,
  type FundTermKeys,
} from './index.ts';

const WORDS: BannedWord[] = [
  { word: '最低价', category: 'price_rebate', scopes: ['user_visible', 'admin_report'] },
  {
    word: '佣金',
    category: 'fund',
    scopes: ['user_visible'],
    allow_keys: ['agent.disclaimer.commission'],
  },
  {
    word: '比价',
    category: 'field_limited',
    scopes: ['user_visible', 'admin_report'],
    allow_keys: ['reason.*.desc'],
    allow_rendered_in: ['ORDER_INVALID'],
    allow_articles: [{ config_key: 'help.price', fields: ['body'] }],
  },
];

it('[AC-F1-02r#4] normalization keeps non-ASCII case and strips separators, marks and controls', () => {
  expect(normalizeForMatch('Ｍ最​低—价 Ä')).toBe('m最低价Ä');
  expect(normalizeForMatch('­abc\u0007')).toBe('abc');
});

it('[AC-F1-02r#5] scope filters words before matching', () => {
  const input = { fragments: [{ text: '佣 金 / 最低价' }] };
  expect(findBannedWords(input, WORDS, 'user_visible')).toEqual(['最低价', '佣金']);
  expect(findBannedWords(input, WORDS, 'admin_report')).toEqual(['最低价']);
});

it('[AC-F1-02r#7] wildcard key segment must be one non-empty segment', () => {
  const hits = (key: string): string[] =>
    findBannedWords({ fragments: [{ key, text: '比价' }] }, WORDS, 'user_visible');
  expect(hits('reason.A.desc')).toEqual([]);
  expect(hits('reason..desc')).toEqual(['比价']);
  expect(hits('reason.A.B.desc')).toEqual(['比价']);
});

it('[AC-F1-02r#8] template context requires allow_rendered_in, articles require config key and field', () => {
  const fragment = { key: 'reason.A.desc', text: '比价' };
  expect(
    findBannedWords(
      { template_code: 'ORDER_INVALID', fragments: [fragment] },
      WORDS,
      'user_visible',
    ),
  ).toEqual([]);
  expect(
    findBannedWords({ template_code: 'CREDITED', fragments: [fragment] }, WORDS, 'user_visible'),
  ).toEqual(['比价']);
  const article = { article_config_keys: ['help.price'], fragments: [{ text: '比价' }] };
  expect(findBannedWords({ ...article, article_field: 'body' }, WORDS, 'user_visible')).toEqual([]);
  expect(findBannedWords({ ...article, article_field: 'title' }, WORDS, 'user_visible')).toEqual([
    '比价',
  ]);
});

it('[AC-F1-02r#14] fragments are matched separately and a word normalizing to empty never hits', () => {
  expect(
    findBannedWords({ fragments: [{ text: '最低' }, { text: '价' }] }, WORDS, 'user_visible'),
  ).toEqual([]);
  const empty: BannedWord[] = [{ word: '★', category: 'test', scopes: ['user_visible'] }];
  expect(findBannedWords({ fragments: [{ text: '★任何文字' }] }, empty, 'user_visible')).toEqual(
    [],
  );
});

const KEYS: FundTermKeys = {
  fund_terms: { prefixes: ['order_status.'], keys: ['tag.rebate'], notify_templates: ['CREDITED'] },
  ordinary: {
    prefixes: ['privacy.', 'btn.'],
    keys: ['perm.push'],
    notify_templates: ['SMS_CODE'],
  },
  exempt: [],
};

it('[AC-F1-02r#17] key classification', () => {
  expect(classifyTextKey('order_status.PAID', KEYS)).toBe('fund_terms');
  expect(classifyTextKey('tag.rebate', KEYS)).toBe('fund_terms');
  expect(classifyTextKey('privacy.notice', KEYS)).toBe('agreement');
  expect(classifyTextKey('perm.push', KEYS)).toBe('agreement');
  expect(classifyTextKey('btn.buy', KEYS)).toBe('general');
  expect(classifyTextKey('unknown', KEYS)).toBe('fund_terms');
});

it('[AC-F1-02r#21] template classification', () => {
  expect(classifyTemplate('CREDITED', KEYS)).toBe('fund_terms');
  expect(classifyTemplate('SMS_CODE', KEYS)).toBe('general');
  expect(classifyTemplate('NOPE', KEYS)).toBe('fund_terms');
});

it('[AC-F1-02r#25] variables compare as sets and report differences', () => {
  const defaults = { k: '共 {a} 和 {b}', plain: '无变量' };
  expect(checkTextVariables('k', '{b}{a}{a}', defaults)).toEqual({ ok: true });
  expect(checkTextVariables('k', '{a}{c}', defaults)).toEqual({
    ok: false,
    reason: 'variables_mismatch',
    missing: ['b'],
    extra: ['c'],
  });
  expect(checkTextVariables('plain', '有 { 括号', defaults)).toEqual({
    ok: false,
    reason: 'variables_mismatch',
    missing: [],
    extra: [],
  });
  expect(checkTextVariables('hasOwnProperty', 'x', defaults)).toEqual({
    ok: false,
    reason: 'unknown_key',
  });
});
