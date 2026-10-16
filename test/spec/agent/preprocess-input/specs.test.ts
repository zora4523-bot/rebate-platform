import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import {
  inputKeywordLists,
  pageGuideParamPatterns,
} from '../../../../apps/api/src/modules/agent/preprocess/input/index.ts';

// 不固定词表全量；依据任务书 §9/U-5，词表与正则模式由实现者起草。
// 必须先调骨架再读文件，test 阶段不能创建 specs，不能以 ENOENT 冒充先红。
it('[AC-B3-05d#23][BR-AI-18] advice/prohibited 两组运行时词表与 specs 逐项一致', () => {
  const actual = inputKeywordLists();
  const file = new URL('../../../../specs/agent-input-keywords.yaml', import.meta.url);
  expect(existsSync(file)).toBe(true);
  expect(actual).toEqual(parseYamlLite(readFileSync(file, 'utf8')));
  expect(Object.keys(actual).sort()).toEqual(['advice', 'prohibited']);
  for (const words of [actual.advice, actual.prohibited]) {
    expect(words.length).toBeGreaterThan(0);
    for (const word of words) expect(word.trim().length).toBeGreaterThan(0);
  }
});

it('[AC-B3-05d#24][BR-AI-01] 页面参数模式与 specs 逐项一致并能覆盖规格示例', () => {
  const actual = pageGuideParamPatterns();
  const file = new URL('../../../../specs/agent-page-guide-params.yaml', import.meta.url);
  expect(existsSync(file)).toBe(true);
  expect(actual).toEqual(parseYamlLite(readFileSync(file, 'utf8')));
  expect(actual.patterns.length).toBeGreaterThan(0);
  for (const source of actual.patterns) {
    expect(source.trim().length).toBeGreaterThan(0);
    expect(() => new RegExp(source, 'u')).not.toThrow();
  }
  for (const example of [
    '名称=值',
    '名称:值',
    'withdrawal_id=W123',
    '单号 SYNTHETIC0001',
    'ID SYNTHETIC0002',
  ]) {
    expect(actual.patterns.some((source) => new RegExp(source, 'u').test(example))).toBe(true);
  }
  for (const example of ['钱包在哪', '提现记录在哪看', '我的订单在哪看']) {
    expect(actual.patterns.some((source) => new RegExp(source, 'u').test(example))).toBe(false);
  }
});
