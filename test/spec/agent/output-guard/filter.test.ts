import { expect, it } from 'vitest';
import { filterSegment } from '../../../../apps/api/src/modules/agent/guard/index.ts';
import { amounts, folded, graderAmounts, links, passcodes, quantities } from './kit.ts';

it('[AC-B3-06a#1] BR-AI-06 原例保留说明文字，命中类型完整', () => {
  const result = filterSegment('这款券后 29.9 元，点 https://s.click.taobao.com/x');
  expect(result.text).toBe('这款券后见卡片，点');
  expect(new Set(result.hits)).toEqual(new Set(['amount', 'url']));
});

it.each(amounts)('[AC-B3-06a#2] 金额式 %s 覆盖完整数字', (input) => {
  const result = filterSegment(input);
  expect(result.text).toBe('见卡片');
  expect(result.hits).toEqual(['amount']);
});

it.each([
  ...quantities,
  '四角内裤',
  '六角扳手',
  '八角',
  '三角巾',
  'example.community',
  'config.cnf',
  'a.netx',
  '**AbCd1234**',
  'ＡＢＣ，保留原样',
])('[AC-B3-06a#3] 非金额或链接 %s 逐字保留', (input) => {
  expect(filterSegment(input)).toEqual({ text: input, hits: [] });
});

it.each(['¥29.9元', '39元29元', '满 100 减 20', '¥29.9', '29元 \t 39元', '¥29.9元 85% 券5'])(
  '[AC-B3-06a#4] 重叠或水平空白相邻金额 %s 合并',
  (input) => {
    expect(filterSegment(input)).toEqual({ text: '见卡片', hits: ['amount'] });
  },
);

it('[AC-B3-06a#4] 有说明文字隔开的金额不合并，不吞掉说明文字', () => {
  expect(filterSegment('29元，对比39元').text).toBe('见卡片，对比见卡片');
});

it('[AC-B3-06a#4] 移除命中前水平空白时保留换行', () => {
  expect(filterSegment('前\n \t29元')).toEqual({ text: '前\n见卡片', hits: ['amount'] });
});

it.each(links)('[AC-B3-06a#5] URL / scheme / 域名 %s 只删除命中串与前置水平空白', (link) => {
  expect(filterSegment(`点 \t${link} 查看`)).toEqual({ text: '点 查看', hits: ['url'] });
});

it('[AC-B3-06a#5] URL 后紧跟中文的说明仍保留', () => {
  expect(filterSegment('点https://x.com/a购买更划算。')).toEqual({
    text: '点购买更划算。',
    hits: ['url'],
  });
});

it.each(passcodes)('[AC-B3-06a#6] 口令 %s 删除且保留两侧文字', (code) => {
  expect(filterSegment(`前文 \t${code} 后文`)).toEqual({ text: '前文 后文', hits: ['tpwd'] });
});

it.each(['￥', '$', '€', '/', '£', '¢', '₳', '(', '（'])(
  '[AC-B3-06a#6] %s 包裹口令仅接受 8–14 位',
  (open) => {
    const close = open === '(' ? ')' : open === '（' ? '）' : open;
    for (const size of [7, 8, 14, 15]) {
      const input = `${open}${'A'.repeat(size)}${close}`;
      expect(filterSegment(input)).toEqual(
        size === 8 || size === 14 ? { text: '', hits: ['tpwd'] } : { text: input, hits: [] },
      );
    }
  },
);

it.each(folded)('[AC-B3-06a#7] 全角命中 %s 不改变未命中的全角文字与标点', (input) => {
  const amount = input === '２９元' || input === '８５％';
  expect(filterSegment(`Ａ，${input}，尾`)).toEqual({
    text: `Ａ，${amount ? '见卡片' : ''}，尾`,
    hits: [amount ? 'amount' : input.startsWith('￥') ? 'tpwd' : 'url'],
  });
});

it.each(graderAmounts)('[AC-B3-06a#23] 判分器覆盖的繁体与大写金额 %s 也替换', (input) => {
  expect(filterSegment(input)).toEqual({ text: '见卡片', hits: ['amount'] });
});
