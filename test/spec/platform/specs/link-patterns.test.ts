import { expect, it } from 'vitest';
import { getLinkPatterns } from '../../../../apps/api/src/modules/platform/specs/link-patterns.ts';
import { linkPatternsSource } from '../../../../apps/api/src/modules/platform/specs/scripts/generate-link-patterns.ts';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import {
  generatedValue,
  platformExports,
  readGenerated,
  readSource,
  renderFixture,
  sourceFile,
} from './kit.ts';

it('[AC-CT-15m#1] link-patterns 生成常量存在且与 YAML 全量一致，缺失或漂移必须失败', async () => {
  const value = generatedValue(await readGenerated('link-patterns'), 'LINK_PATTERNS');
  expect(value).toStrictEqual(await readSource('link-patterns'));
});

it('[AC-CT-15m#2] link-patterns 重新生成的文本与已入库文件逐字一致', async () => {
  const source = await linkPatternsSource(sourceFile('link-patterns'));
  expect(await readGenerated('link-patterns')).toBe(source);
});

// Synthetic domains only: these are not platform samples or production rules.
const NONEMPTY_YAML = `version: '0007'
rules:
  - platform: jd
    category: union_host
    hosts: ['z.example.test', 'a.example.test']
    path_patterns: []
  - platform: jd
    category: product
    hosts: ['item.z.example.test', 'item.a.example.test']
    path_patterns: ['/商品/**', '/Item/*', '/item/*.html']
  - platform: taobao
    category: promo
    hosts: ['promo.example.test']
    path_patterns: ['/z/**', '/a/*']
`;

it('[AC-CT-15m#3] link-patterns 非空生成保留版本字符串、所有字段及规则和嵌套数组顺序', async () => {
  const source = await renderFixture(linkPatternsSource, NONEMPTY_YAML);
  expect(generatedValue(source, 'LINK_PATTERNS')).toStrictEqual(parseYamlLite(NONEMPTY_YAML));
});

it('[AC-CT-15m#4] link-patterns 运行时取值与源规格一致', async () => {
  expect(getLinkPatterns()).toStrictEqual(await readSource('link-patterns'));
});

it('[AC-CT-15m#5] platform/index.ts 提供 link-patterns 常量及取值函数', async () => {
  const platform = await platformExports();
  expect(platform['LINK_PATTERNS']).toStrictEqual(await readSource('link-patterns'));
  expect(platform['getLinkPatterns']).toBe(getLinkPatterns);
  expect(getLinkPatterns()).toStrictEqual(platform['LINK_PATTERNS']);
});
