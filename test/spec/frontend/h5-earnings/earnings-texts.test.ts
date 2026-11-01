import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { collectH5Texts, type TrimTextDictionary } from '../../../../apps/h5/build/trim-texts.ts';

const ROOT = new URL('../../../../', import.meta.url);
const SOURCE_ROOT = fileURLToPath(new URL('apps/h5/src/', ROOT));

function contractDictionary(): TrimTextDictionary {
  return JSON.parse(
    readFileSync(new URL('contracts/texts.default.json', ROOT), 'utf8'),
  ) as TrimTextDictionary;
}

it('[AC-F1-12a-TEXTS#1] 构建期文案收集覆盖本页的全部 earnings.* 键与三态错误文案（动态键须登记）', () => {
  const dictionary = contractDictionary();
  // 动态拼出的键（如 earnings.period.<key>）没被 texts/dynamic-keys.ts 覆盖时收集器直接报错。
  const collected = collectH5Texts({ sourceRoot: SOURCE_ROOT, dictionary });
  const wanted = [
    ...Object.keys(dictionary.texts).filter((key) => key.startsWith('earnings.')),
    'error.30701',
    'error.10405',
    'h5.load_failed',
  ];
  expect(wanted.length).toBeGreaterThan(3);
  const missing = wanted.filter((key) => collected.texts[key] !== dictionary.texts[key]);
  expect(missing, '打进 H5 包的字典须含这些键').toEqual([]);
});
