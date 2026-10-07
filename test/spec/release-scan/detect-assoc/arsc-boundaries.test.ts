import { expect, it } from 'vitest';
import { arsc, axml } from './android-fixtures.ts';
import {
  expectClean,
  expectPair,
  expectSecret,
  expectUnreadable,
  inspect,
  LOW,
  SHORT,
} from './fixtures.ts';

it.each(['monkey', 'turkey', 'keyboard', 'keypad', 'hockey', 'tokenizer', 'monkey_label'])(
  '[AC-QA-09d-ARSC#1] arsc 普通资源名 %s 内的 key/token 子串不是凭据字段',
  async (name) => {
    const result = await inspect('apk', [
      { name: 'AndroidManifest.xml', data: axml([]) },
      { name: 'resources.arsc', data: arsc([{ name, value: LOW }]) },
    ]);
    expectPair(result, 'resources.arsc', name, LOW);
    expectClean(result);
  },
  30_000,
);

it.each(['api_key', 'apiKey', 'access_token', 'sdkCredential', 'key', 'token'])(
  '[AC-QA-09d-ARSC#2] 真正的凭据字段 %s 仍按 keyed-credential 阻断低熵值',
  async (name) => {
    const result = await inspect('apk', [
      { name: 'AndroidManifest.xml', data: axml([]) },
      { name: 'resources.arsc', data: arsc([{ name, value: LOW }]) },
    ]);
    expectPair(result, 'resources.arsc', name, LOW);
    expect(result.scan.errors).toEqual([]);
    expect(result.scan.exit_code).toBe(1);
    expect(result.scan.passed).toBe(false);
    expect(result.scan.hits).toContainEqual({
      rule: 'keyed-credential',
      file: 'resources.arsc',
      line: expect.any(Number),
      match: LOW,
      never_accepted: false,
    });
  },
  30_000,
);

it('[AC-QA-09d-ARSC#3] 收窄字段子串不能免除普通名字下的高熵扫描', async () => {
  const value = '0123456789abcdef'.repeat(2);
  const result = await inspect('apk', [
    { name: 'AndroidManifest.xml', data: axml([]) },
    { name: 'resources.arsc', data: arsc([{ name: 'monkey', value }]) },
  ]);
  expectPair(result, 'resources.arsc', 'monkey', value);
  expect(result.scan.errors).toEqual([]);
  expect(result.scan.exit_code).toBe(1);
  expect(result.scan.hits).toContainEqual({
    rule: 'high-entropy',
    file: 'resources.arsc',
    line: expect.any(Number),
    match: value,
    never_accepted: false,
  });
  expect(result.scan.hits.some((hit) => hit.rule === 'keyed-credential')).toBe(false);
}, 30_000);

it('[AC-QA-09d-ARSC#4] 收窄 keyed-credential 不削弱签名字段的短值检测', async () => {
  const result = await inspect('apk', [
    { name: 'AndroidManifest.xml', data: axml([]) },
    { name: 'resources.arsc', data: arsc([{ name: 'shared_salt', value: SHORT }]) },
  ]);
  expectPair(result, 'resources.arsc', 'shared_salt', SHORT);
  expectSecret(result, 'resources.arsc', SHORT);
}, 30_000);

it('[AC-QA-09d-ARSC#5] arsc 自身签名资源悬空引用仍返回读取错误', async () => {
  const result = await inspect('apk', [
    { name: 'AndroidManifest.xml', data: axml([]) },
    { name: 'resources.arsc', data: arsc([{ name: 'shared_salt', value: { ref: 0x7f010009 } }]) },
  ]);
  expectUnreadable(result, 'resources.arsc');
}, 30_000);

it('[AC-QA-09d-ARSC#6] 关联新增逻辑不能丢失普通 assets 配置文件的签名材料检测', async () => {
  const result = await inspect('apk', [
    { name: 'AndroidManifest.xml', data: axml([]) },
    { name: 'resources.arsc', data: arsc([{ name: 'monkey', value: LOW }]) },
    { name: 'assets/release.json', data: JSON.stringify({ shared_salt: SHORT }) },
  ]);
  expect(result.associated.views.some((view) => view.path === 'assets/release.json')).toBe(true);
  expectSecret(result, 'assets/release.json', SHORT);
  expect(result.scan.hits.some((hit) => hit.file === 'resources.arsc')).toBe(false);
}, 30_000);
