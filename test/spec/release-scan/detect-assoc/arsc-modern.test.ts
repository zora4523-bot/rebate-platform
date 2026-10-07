import { expect, it } from 'vitest';
import { arsc, axml } from './android-fixtures.ts';
import { modernArsc } from './arsc-modern-fixtures.ts';
import { expectClean, expectPair, expectUnreadable, LOW } from './fixtures.ts';
import { inspectRevision } from './revision-inspect.ts';

it.each([
  { entryFlags: 0x10 },
  { span: { first: 1, last: 0 } },
  { entryFlags: 0x10, span: { first: 1, last: 0 } },
])(
  '[AC-QA-09d-ARSC-R2#1] FLAG_USES_FEATURE_FLAGS / first=len,last=len-1 的空 span 合法：%j',
  async (options) => {
    const result = await inspectRevision('apk', [
      { name: 'AndroidManifest.xml', data: axml([]) },
      { name: 'resources.arsc', data: modernArsc(options) },
    ]);
    expectPair(result, 'resources.arsc', 'label', 'Demo');
    expectClean(result);
  },
  30_000,
);

it.each([
  { first: 2, last: 1 },
  { first: 0, last: 1 },
])(
  '[AC-QA-09d-ARSC-R2#2] 空 span 兼容不能放过字符串边界外的 span：%j',
  async (span) => {
    const result = await inspectRevision('apk', [
      { name: 'AndroidManifest.xml', data: axml([]) },
      { name: 'resources.arsc', data: modernArsc({ span }) },
    ]);
    expectUnreadable(result, 'resources.arsc');
  },
  30_000,
);

it('[AC-QA-09d-ARSC-R2#3] 100001 个合法短串可读，最后一项资源值不能被截断', async () => {
  const result = await inspectRevision('apk', [
    { name: 'AndroidManifest.xml', data: axml([]) },
    { name: 'resources.arsc', data: modernArsc({ count: 100_001 }), method: 0 },
  ]);
  expectPair(result, 'resources.arsc', 'label', 'Demo');
  expectClean(result);
}, 120_000);

// 本轮技术边界：至少100001串可读；超过1000000串仍必须 fail-closed。
// 不把具体中间阈值写死，允许实现选更小预算，但不能恢复旧的100000上限。
it('[AC-QA-09d-ARSC-R2#4] 1000001 个短串超过解析工作预算，退出码 2 而非部分扫描放行', async () => {
  const result = await inspectRevision('apk', [
    { name: 'AndroidManifest.xml', data: axml([]) },
    { name: 'resources.arsc', data: modernArsc({ count: 1_000_001 }), method: 0 },
  ]);
  expectUnreadable(result, 'resources.arsc');
}, 120_000);

it.each(['apikey', 'appkey', 'accesstoken'])(
  '[AC-QA-09d-ARSC-R2#5] 连写凭据名 %s 仍是 keyed-credential',
  async (name) => {
    const result = await inspectRevision('apk', [
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
