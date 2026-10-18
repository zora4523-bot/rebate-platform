import { expect, it } from 'vitest';
import {
  findBannedWords,
  normalizeForMatch,
} from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import type {
  BannedWord,
  TextGuardInput,
} from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import { vectors, words } from './fixtures.ts';

it.each(vectors.cases)('[AC-F1-02r#1] 共用归一化向量：$input', ({ input, normalized }) => {
  expect(normalizeForMatch(input)).toBe(normalized);
});

it.each(vectors.cases)('[AC-F1-02r#2] 共用命中向量：$input', ({ input, hits }) => {
  expect(findBannedWords({ fragments: [{ text: input }] }, words, 'user_visible')).toEqual(hits);
});

it('[AC-F1-02r#3] 所有向量实际命中与放行计数符合 counts', () => {
  const results = vectors.cases.map(({ input }) =>
    findBannedWords({ fragments: [{ text: input }] }, words, 'user_visible'),
  );
  expect({
    hit: results.filter((hits) => hits.length > 0).length,
    pass: results.filter((hits) => hits.length === 0).length,
  }).toEqual(vectors.counts);
  expect(results).toHaveLength(vectors.counts.hit + vectors.counts.pass);
});

it.each([
  ['ＡＢＣ１２３', 'abc123'],
  ['A\u030A É Ω Я Z', 'ÅÉΩЯz'],
  ['\u24B6\uFB03\u2163', 'affiiv'],
  ['最\u200b\u2060\uFEFF\u{E0100}\u3164低\t\n\u0000\u2028\u00A0价', '最低价'],
  ['', ''],
  [' \t★！\u0301\u093E\u20DD', ''],
])('[AC-F1-02r#4] NFKC 先于剔除，仅 A–Z 转小写：%j', (input, expected) => {
  expect(normalizeForMatch(input)).toBe(expected);
});

it.each([
  ['佣金', ['佣金'], []],
  ['高佣', ['高佣'], []],
  ['收益榜', ['收益榜'], []],
  ['待结算 结算中 返现 充值 备付金', ['待结算', '结算中', '返现', '充值', '备付金'], []],
  ['最低价', ['最低价'], ['最低价']],
  ['返利到账', ['返利到账'], ['返利到账']],
  ['比价', ['比价'], ['比价']],
] as const)('[AC-F1-02r#5] scopes 按词过滤：%s', (text, userHits, adminHits) => {
  expect(findBannedWords({ fragments: [{ text }] }, words, 'user_visible')).toEqual(userHits);
  expect(findBannedWords({ fragments: [{ text }] }, words, 'admin_report')).toEqual(adminHits);
});

it.each([
  ['agent.disclaimer.commission', '佣~金 最低价', ['最低价']],
  ['agent.disclaimer.commission.extra', '佣金', ['佣金']],
  ['agent.disclaimer.COMMISSION', '佣金', ['佣金']],
  ['ａｇｅｎｔ.disclaimer.commission', '佣金', ['佣金']],
  ['order_reason.PRICE_COMPARE.desc', '比★价 最低价', ['最低价']],
  ['order_reason.PRICE_COMPARE.desc.extra', '比价', ['比价']],
] as const)('[AC-F1-02r#6] 原始字段键精确白名单且只豁免对应词：%s', (key, text, hits) => {
  expect(findBannedWords({ fragments: [{ key, text }] }, words, 'user_visible')).toEqual(hits);
});

it.each([
  ['notice.ONE.desc', []],
  ['notice.中文.desc', []],
  ['notice..desc', ['比价']],
  ['notice.desc', ['比价']],
  ['notice.ONE.TWO.desc', ['比价']],
  ['xnotice.ONE.desc', ['比价']],
  ['notice.ONE.desc.more', ['比价']],
  ['noticeXONE.desc', ['比价']],
] as const)('[AC-F1-02r#7] allow_keys 的 * 恰好匹配一个非空段：%s', (key, hits) => {
  const custom: BannedWord[] = [
    {
      word: '比价',
      category: 'field_limited',
      scopes: ['user_visible'],
      allow_keys: ['notice.*.desc'],
    },
  ];
  expect(findBannedWords({ fragments: [{ key, text: '比价' }] }, custom, 'user_visible')).toEqual(
    hits,
  );
});

it.each([
  ['ORDER_INVALID', []],
  ['CLAWBACK', []],
  ['CREDITED', ['比价']],
  ['ORDER_INVALID.extra', ['比价']],
] as const)('[AC-F1-02r#8] 渲染片段必须同时匹配字段与模板白名单：%s', (template_code, hits) => {
  expect(
    findBannedWords(
      {
        template_code,
        fragments: [{ key: 'order_reason.PRICE_COMPARE.desc', text: '比价' }],
      },
      words,
      'user_visible',
    ),
  ).toEqual(hits);
});

it('[AC-F1-02r#9] 允许的通知模板仍检查固定文字和其他字段', () => {
  for (const fragment of [{ text: '比价' }, { key: 'other.key', text: '比价' }]) {
    expect(
      findBannedWords(
        {
          template_code: 'ORDER_INVALID',
          fragments: [{ key: 'order_reason.PRICE_COMPARE.desc', text: '比价' }, fragment],
        },
        words,
        'user_visible',
      ),
    ).toEqual(['比价']);
  }
});

it('[AC-F1-02r#10] 没有 allow_rendered_in 的字典豁免不扩散到通知', () => {
  expect(
    findBannedWords(
      {
        template_code: 'ORDER_INVALID',
        fragments: [{ key: 'agent.disclaimer.commission', text: '佣金' }],
      },
      words,
      'user_visible',
    ),
  ).toEqual(['佣金']);
});

it.each([
  [['other', 'help_links.price_compare'], 'body', ['最低价']],
  [['help_links.price_compare'], 'title', ['最低价']],
  [[], 'body', ['最低价', '比价']],
  [['help_links.price_compare.extra'], 'body', ['最低价', '比价']],
  [['help_links.price_compare'], 'summary', ['最低价', '比价']],
] as const)('[AC-F1-02r#11] 文章豁免同时核对配置键与字段：%j / %s', (keys, field, hits) => {
  expect(
    findBannedWords(
      {
        article_config_keys: keys,
        article_field: field,
        fragments: [{ text: '比价' }, { text: '比★价 最低价' }],
      },
      words,
      'user_visible',
    ),
  ).toEqual(hits);
});

it('[AC-F1-02r#12] 文章上下文缺一项时不豁免', () => {
  for (const context of [
    { article_config_keys: ['help_links.price_compare'] },
    { article_field: 'body' },
  ]) {
    expect(
      findBannedWords({ ...context, fragments: [{ text: '比价' }] }, words, 'user_visible'),
    ).toEqual(['比价']);
  }
});

it('[AC-F1-02r#13] 按传入 words 顺序报告，重复词与重复出现只返回一次', () => {
  const custom: BannedWord[] = ['比价', '最低价', '比价', '佣金'].map((word) => ({
    word,
    category: 'test',
    scopes: ['user_visible'],
  }));
  expect(
    findBannedWords(
      { fragments: [{ text: '佣金 最低价 比价 最低价' }, { text: '佣金' }] },
      custom,
      'user_visible',
    ),
  ).toEqual(['比价', '最低价', '佣金']);
});

it('[AC-F1-02r#14] 不跨片段拼接，空片段与空词表没有命中', () => {
  expect(
    findBannedWords({ fragments: [{ text: '最低' }, { text: '价' }] }, words, 'user_visible'),
  ).toEqual([]);
  expect(findBannedWords({ fragments: [] }, words, 'user_visible')).toEqual([]);
  expect(findBannedWords({ fragments: [{ text: '最低价' }] }, [], 'user_visible')).toEqual([]);
});

it('[AC-F1-02r#15] 文本和词表都归一化，但结果保留词表原词', () => {
  const custom: BannedWord[] = [{ word: 'Ａ-B', category: 'test', scopes: ['user_visible'] }];
  expect(findBannedWords({ fragments: [{ text: '前a★b后' }] }, custom, 'user_visible')).toEqual([
    'Ａ-B',
  ]);
});

it('[AC-F1-02r#16] 匹配不修改输入片段或词表白名单', () => {
  const input: TextGuardInput = {
    fragments: [{ key: 'order_reason.PRICE_COMPARE.desc', text: '比★价' }, { text: '佣~金' }],
    template_code: 'ORDER_INVALID',
    article_config_keys: ['other'],
    article_field: 'body',
  };
  const inputBefore = structuredClone(input);
  const custom = structuredClone(words);
  const wordsBefore = structuredClone(custom);
  expect(findBannedWords(input, custom, 'user_visible')).toEqual(['佣金']);
  expect(input).toEqual(inputBefore);
  expect(custom).toEqual(wordsBefore);
});
