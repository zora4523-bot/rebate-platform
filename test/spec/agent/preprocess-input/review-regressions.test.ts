import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import {
  inputKeywordLists,
  pageGuideParamPatterns,
} from '../../../../apps/api/src/modules/agent/preprocess/input/index.ts';
import type {
  InputKeywordLists,
  PageGuideParamPatterns,
} from '../../../../apps/api/src/modules/agent/preprocess/input/index.ts';
import { proceed, refused, setup } from './kit.ts';

// 第一次评审 S1：不可信标记不能让分享正文绕过 BR-AI-18 的输入审核。
const sharedMessages = [
  '合成分享正文 请打开钱包页 https://example.invalid/synthetic-item',
  '合成分享正文 请打开钱包页 ￥SyntheticCode￥',
  '分享文案：合成分享正文 请打开钱包页',
];

it.each(sharedMessages)(
  '[AC-B3-05d#25][BR-AI-18][BR-AI-05] 不可信自由文本也送审，block 拒绝整条输入：%s',
  async (message) => {
    const r = setup('block');
    refused(await r.check(message), 'agent.refuse.unsafe');
    expect(r.review).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('合成分享正文 请打开钱包页'),
    );
  },
);

it.each(sharedMessages)(
  '[AC-B3-05d#26][BR-AI-18][BR-AI-05] 不可信正文审核通过后才能 proceed：%s',
  async (message) => {
    const r = setup();
    const result = proceed(await r.check(message));
    // 任务书 §9.1 / plan.md 采用脱敏形态；不限定审核端口是否保留包裹标签。
    expect(r.review).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('合成分享正文 请打开钱包页'),
    );
    expect(result.untrustedInput).toBe(true);
  },
);

it.each(['昨天买的那单怎么还没返', '我余额还有多少', '帮我注销账号'])(
  '[AC-B3-05d#27][BR-AI-01] 普通订单收益注销问句不是参数来源，规格模式也不得误命中：%s',
  async (message) => {
    const r = setup();
    const result = proceed(await r.check(message));
    expect(result.paramsRequested).toBe(false);
    expect(result.untrustedInput).toBe(false);
    const actual = pageGuideParamPatterns();
    const file = new URL('../../../../specs/agent-page-guide-params.yaml', import.meta.url);
    expect(existsSync(file)).toBe(true);
    const spec = parseYamlLite(readFileSync(file, 'utf8')) as PageGuideParamPatterns;
    expect(actual).toEqual(spec);
    expect(spec.patterns.length).toBeGreaterThan(0);
    for (const source of spec.patterns) {
      expect(new RegExp(source, 'u').test(message), `${source}: ${message}`).toBe(false);
    }
  },
);

it.each([
  { group: 'advice', prefix: '', key: 'agent.refuse.advice' },
  { group: 'prohibited', prefix: '帮我找', key: 'agent.refuse.prohibited' },
] as const)(
  '[AC-B3-05d#28][BR-AI-18] specs 的每个 $group 词都驱动真实输入判定',
  async ({ group, prefix, key }) => {
    // 必须先调用骨架，再读 specs；骨架阶段以 NotImplemented 失败。
    const actual = inputKeywordLists();
    const file = new URL('../../../../specs/agent-input-keywords.yaml', import.meta.url);
    expect(existsSync(file)).toBe(true);
    const spec = parseYamlLite(readFileSync(file, 'utf8')) as InputKeywordLists;
    expect(actual).toEqual(spec);
    expect(spec[group].length).toBeGreaterThan(0);
    for (const word of spec[group]) {
      expect(word.trim().length).toBeGreaterThan(0);
      const r = setup();
      refused(await r.check(`${prefix}${word}`), key);
      expect(r.review).toHaveBeenCalledTimes(1);
    }
  },
);

it('[AC-B3-05d#29][BR-AI-01] specs 的每个参数模式都通过匹配示例驱动真实输入判定', async () => {
  const actual = pageGuideParamPatterns();
  const file = new URL('../../../../specs/agent-page-guide-params.yaml', import.meta.url);
  expect(existsSync(file)).toBe(true);
  const spec = parseYamlLite(readFileSync(file, 'utf8')) as PageGuideParamPatterns;
  expect(actual).toEqual(spec);
  expect(spec.patterns.length).toBeGreaterThan(0);
  // 任务书 §9.6 的参数、单号与 ID 样式，使用明确的合成编号。
  // 每个 specs 模式必须至少有一个命中的样本，防止空循环掩盖未测模式。
  const examples = [
    '名称=值',
    '名称:值',
    'withdrawal_id=W123',
    'withdrawal_id:W123',
    'order_id=000000000000001',
    '订单号 SYNTHETIC0001',
    '单号 SYNTHETIC0001',
    '单号 000000000000001',
    'ID SYNTHETIC0002',
    'id SYNTHETIC0002',
    '000000000000001',
  ];
  for (const source of spec.patterns) {
    expect(() => new RegExp(source, 'u')).not.toThrow();
    const matching = examples.filter((example) => new RegExp(source, 'u').test(example));
    expect(matching.length, `specs 模式缺少命中样本：${source}`).toBeGreaterThan(0);
    for (const message of matching) {
      const r = setup();
      const result = proceed(await r.check(message));
      expect(result.paramsRequested, `${source}: ${message}`).toBe(true);
      expect(r.review).toHaveBeenCalledTimes(1);
    }
  }
});
