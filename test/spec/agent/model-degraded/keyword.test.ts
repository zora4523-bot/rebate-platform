// 规划/08 BR-AI-14 细则「无模型降级」的取词与搜索参数：q = 脱敏后的剩余自由文本去掉首尾空白与
// 标点后取前 30 个字符，platforms 取全部已开启平台，sort=relevance，不抽取价格与规格条件。
// 口径（代理默认，couli-runs/B3-02d/tests-claude.md）：字符按 Unicode 码点计（plan.md §6 K11）；
// 标点 = Unicode 类别 P，空白 = JS \s（含全角空格 U+3000）；先去首尾、再截取（08 原文顺序）。
// 期望值一律手写字面量。
import { expect, it } from 'vitest';
import {
  planKeywordSearch,
  type RedactedText,
} from '../../../../apps/api/src/modules/agent/model-gateway/degraded/index.ts';

/** 测试里模拟 B3-05 脱敏函数的产出；只用合成文本，不含真实个人信息。 */
function redacted(text: string): RedactedText {
  return text as RedactedText;
}

const PLATFORMS = ['taobao', 'jd', 'pdd'] as const;

it.each([
  ['  我想买一个蓝牙耳机！！ ', '我想买一个蓝牙耳机'],
  ['　　降噪耳机　', '降噪耳机'],
  ['\n\t猫粮 成猫\r\n', '猫粮 成猫'],
  ['"——《三体》——"', '三体'],
  ['【推荐】……iPhone 15 手机壳？?!', '推荐】……iPhone 15 手机壳'],
  ['...「洗衣液、柔顺剂」·', '洗衣液、柔顺剂'],
  ['猫粮  成猫，三公斤', '猫粮  成猫，三公斤'],
  ['a', 'a'],
  ['，耳机🎧', '耳机🎧'],
])(
  '[BR-AI-14] 去掉首尾空白（含全角空格）与中英文标点，中间的空白和标点原样保留：%j → %j',
  (input, q) => {
    expect(planKeywordSearch(redacted(input), PLATFORMS)).toStrictEqual({
      q,
      platforms: ['taobao', 'jd', 'pdd'],
      sort: 'relevance',
    });
  },
);

it.each([
  // 29 个码点：原样保留
  [
    '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九',
    '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九',
  ],
  // 30 个码点：原样保留
  [
    '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十',
    '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十',
  ],
  // 31 个码点：截掉最后 1 个
  [
    '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十甲',
    '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十',
  ],
  // 36 个 ASCII：取前 30
  ['abcdefghijklmnopqrstuvwxyz0123456789', 'abcdefghijklmnopqrstuvwxyz0123'],
  // 先去首部标点与空白再计数：前缀不占 30 个字符的名额
  ['，，， 　abcdefghijklmnopqrstuvwxyz0123456789', 'abcdefghijklmnopqrstuvwxyz0123'],
  // 35 个码点、42 个 UTF-16 单元：emoji 按 1 个字符计，不会被切成半个
  [
    '蓝牙耳机🎧蓝牙耳机🎧蓝牙耳机🎧蓝牙耳机🎧蓝牙耳机🎧蓝牙耳机🎧蓝牙耳机🎧',
    '蓝牙耳机🎧蓝牙耳机🎧蓝牙耳机🎧蓝牙耳机🎧蓝牙耳机🎧蓝牙耳机🎧',
  ],
  // 08 的顺序是先去首尾再取前 30：截取后的末尾恰好是标点也不再去掉
  ['abcdefghijklmnopqrstuvwxyz012，xyz', 'abcdefghijklmnopqrstuvwxyz012，'],
])('[BR-AI-14] 去掉首尾后按 Unicode 码点取前 30 个字符 #%#', (input, q) => {
  const plan = planKeywordSearch(redacted(input), PLATFORMS);
  expect(plan).toStrictEqual({ q, platforms: ['taobao', 'jd', 'pdd'], sort: 'relevance' });
});

// 08：「以下时限与取词为代理补全的默认值，可配置」。上限经 options.maxChars 注入，期望值手写。
it.each([
  // 上限 10（小于默认）：取前 10
  [10, 'abcdefghijklmnopqrstuvwxyz0123456789', 'abcdefghij'],
  // 上限 1：只取去首部标点后的第 1 个字符
  [1, '，蓝牙耳机', '蓝'],
  // 上限 10：先去首部标点与空白再计数
  [10, '【】 \u3000abcdefghijklmnop', 'abcdefghij'],
  // 上限 10：截取后末尾恰好是标点也不再去掉
  [10, 'abcdefghi，jk', 'abcdefghi，'],
  // 上限 7、emoji 按 1 个字符计（7 个码点、9 个 UTF-16 单元）
  [7, '耳机🎧蓝牙🎧降噪', '耳机🎧蓝牙🎧降'],
  // 显式配置 30：与默认相同
  [30, 'abcdefghijklmnopqrstuvwxyz0123456789', 'abcdefghijklmnopqrstuvwxyz0123'],
  // 上限 31（大于默认）：31 个码点全保留
  [
    31,
    '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十甲',
    '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十甲',
  ],
  // 上限 50（大于默认）：36 个 ASCII 全保留
  [50, 'abcdefghijklmnopqrstuvwxyz0123456789', 'abcdefghijklmnopqrstuvwxyz0123456789'],
  // 上限 33（奇数、大于默认）：35 个码点取前 33
  [
    33,
    '蓝牙耳机🎧蓝牙耳机🎧蓝牙耳机🎧蓝牙耳机🎧蓝牙耳机🎧蓝牙耳机🎧蓝牙耳机🎧',
    '蓝牙耳机🎧蓝牙耳机🎧蓝牙耳机🎧蓝牙耳机🎧蓝牙耳机🎧蓝牙耳机🎧蓝牙耳',
  ],
] as const)('[BR-AI-14] 取词上限可配置：maxChars=%i 时 %j → %j', (maxChars, input, q) => {
  expect(planKeywordSearch(redacted(input), ['jd'], { maxChars })).toStrictEqual({
    q,
    platforms: ['jd'],
    sort: 'relevance',
  });
});

it('[BR-AI-14] 传了配置对象但没给 maxChars：仍按默认 30 截取', () => {
  expect(
    planKeywordSearch(redacted('abcdefghijklmnopqrstuvwxyz0123456789'), ['jd'], {}),
  ).toStrictEqual({ q: 'abcdefghijklmnopqrstuvwxyz0123', platforms: ['jd'], sort: 'relevance' });
});

it('[BR-AI-14] 配置了较小的上限时，去完首尾为空仍返回 null', () => {
  expect(planKeywordSearch(redacted('  ？！。 '), ['jd'], { maxChars: 3 })).toBeNull();
});

it.each([[''], [' '], ['　\t\n'], ['？！。，'], [' ...!!! '], ['【】《》——…']])(
  '[BR-AI-14] 去掉首尾空白与标点后为空（或输入只有空白和标点）时不做关键词搜索：%j → null',
  (input) => {
    expect(planKeywordSearch(redacted(input), PLATFORMS)).toBeNull();
  },
);

it('[BR-AI-14] platforms 等于传入的全部已开启平台，顺序不变且是副本；sort=relevance；计划只有 q、platforms、sort 三个键（不抽取价格与规格条件）', () => {
  const enabled = ['pdd', 'taobao', 'jd'];
  const plan = planKeywordSearch(redacted('200元以内的蓝牙耳机 黑色'), enabled);
  expect(plan).toStrictEqual({
    q: '200元以内的蓝牙耳机 黑色',
    platforms: ['pdd', 'taobao', 'jd'],
    sort: 'relevance',
  });
  expect(Object.keys(plan ?? {}).sort()).toStrictEqual(['platforms', 'q', 'sort']);
  expect(plan?.platforms).not.toBe(enabled);
  enabled.push('meituan');
  enabled[0] = 'vip';
  expect(plan?.platforms).toStrictEqual(['pdd', 'taobao', 'jd']);
});

it.each([
  [[], []],
  [['jd'], ['jd']],
  [
    ['taobao', 'jd', 'pdd', 'meituan', 'vip'],
    ['taobao', 'jd', 'pdd', 'meituan', 'vip'],
  ],
])(
  '[BR-AI-14] 已开启平台为 0、1、5 个时 platforms 原样照抄（为空也返回计划，由结果判定处理）：%j',
  (enabled, platforms) => {
    expect(planKeywordSearch(redacted('洗衣液'), enabled)).toStrictEqual({
      q: '洗衣液',
      platforms,
      sort: 'relevance',
    });
  },
);

it('[BR-AI-14] 只收脱敏后的文本：普通 string 编译不过，品牌类型的值照常取词', () => {
  const plain = '订单 3812345678901234567 返了吗';
  // @ts-expect-error 普通 string 不是 RedactedText，必须先经 B3-05 的脱敏函数
  const unredacted = (): unknown => planKeywordSearch(plain, PLATFORMS);
  expect(typeof unredacted).toBe('function');
  expect(planKeywordSearch(redacted('订单 <num_1> 返了吗'), ['jd'])).toStrictEqual({
    q: '订单 <num_1> 返了吗',
    platforms: ['jd'],
    sort: 'relevance',
  });
});
