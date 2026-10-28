// B2-11e: app.module takes content only through content's index.ts (apps/api/AGENTS.md「index.ts 是
// 模块唯一的对外出口」), so the TODOs B1-34a (configuration registry) and B2-11d (the config item
// and switch use cases) left beside their direct imports of content's internal files go, and the
// admin entry hands payout's checks to ContentAdminModule.forAdmin as options instead of
// rebuilding the providers forAdmin returns.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const SOURCE = readFileSync(
  new URL('../../../../apps/api/src/app.module.ts', import.meta.url),
  'utf8',
);

it('[AC-B2-11e#6] app.module 只经 content 的 index.ts 导入，直接引 content 内部文件的 TODO 去掉', () => {
  const specifiers = [
    ...SOURCE.matchAll(/\bfrom\s+'(\.\/modules\/content\/[^']*)'/gu),
    ...SOURCE.matchAll(/\bimport\(\s*'(\.\/modules\/content\/[^']*)'/gu),
  ].map((match) => match[1]);
  expect(specifiers).toContain('./modules/content/index.ts');
  expect(specifiers.filter((specifier) => specifier !== './modules/content/index.ts')).toEqual([]);
  const todos = SOURCE.split('\n').filter((line) => /TODO.*content 的 index\.ts/u.test(line));
  expect(todos).toEqual([]);
});

it('[AC-B2-11e#7] admin 入口把保存校验与开启前置检查作为 ContentAdminModule.forAdmin 的选项传入，不再改写它返回的 provider', () => {
  expect(SOURCE).toMatch(/\bContentAdminModule\.forAdmin\(/u);
  expect(SOURCE).toMatch(/\bconfigItemChecks\b/u);
  expect(SOURCE).toMatch(/\bkillSwitchChecks\b/u);
  // B2-11d's wrapper rebuilt the two providers and called withChecks on what they returned.
  expect(SOURCE).not.toMatch(/\.withChecks\(/u);
});
