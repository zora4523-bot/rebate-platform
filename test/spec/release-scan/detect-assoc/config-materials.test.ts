import { generateKeyPairSync } from 'node:crypto';
import { expect, it } from 'vitest';
import { axml } from './android-fixtures.ts';
import { expectClean, expectSecret, SHORT } from './fixtures.ts';
import { inspectRevision } from './revision-inspect.ts';

it.each([
  {
    path: 'assets/config.properties',
    empty: 'shared_salt=\napp.name=foo\n',
    populated: `shared_salt=${SHORT}\napp.name=foo\n`,
  },
  {
    path: 'assets/config.yaml',
    empty: 'hmac:\n  algorithm: sha256\n',
    populated: `hmac: ${SHORT}\nalgorithm: sha256\n`,
  },
])(
  '[AC-QA-09d-CONFIG-R2#1] $path 空值不跨行取值，同一行有值仍阻断',
  async ({ path, empty, populated }) => {
    const clean = await inspectRevision('apk', [
      { name: 'AndroidManifest.xml', data: axml([]) },
      { name: path, data: empty },
    ]);
    expectClean(clean);
    const blocked = await inspectRevision('apk', [
      { name: 'AndroidManifest.xml', data: axml([]) },
      { name: path, data: populated },
    ]);
    expectSecret(blocked, path, SHORT);
  },
  30_000,
);

it('[AC-QA-09d-CONFIG-R2#2] JSON 裸数字签名盐不可豁免，数字算法参数仍放行', async () => {
  const blocked = await inspectRevision('apk', [
    { name: 'AndroidManifest.xml', data: axml([]) },
    { name: 'assets/config.json', data: '{"sign_salt": 20240101}' },
  ]);
  expectSecret(blocked, 'assets/config.json', '20240101');
  const clean = await inspectRevision('apk', [
    { name: 'AndroidManifest.xml', data: axml([]) },
    { name: 'assets/config.json', data: '{"saltRounds":10,"salt_length":16,"saltBits":128}' },
  ]);
  expectClean(clean);
}, 30_000);

it.each(['sec1', 'pkcs8', 'pkcs1'] as const)(
  '[AC-QA-09d-CONFIG-R2#3] 无 PEM 头的 base64 %s 私钥按 private-key 不可豁免阻断',
  async (format) => {
    // 仅在隔离测试中生成一次性密钥，不读已有文件、不写入仓库。
    const key =
      format === 'pkcs1'
        ? generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey
        : generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    const der = key.export({ type: format, format: 'der' });
    if (format === 'sec1') {
      expect([...der.subarray(0, 7)]).toEqual([0x30, 0x77, 0x02, 0x01, 0x01, 0x04, 0x20]);
    }
    const value = der.toString('base64');
    const result = await inspectRevision('apk', [
      { name: 'AndroidManifest.xml', data: axml([]) },
      { name: 'assets/material.txt', data: value },
    ]);
    expect(result.associated.errors).toEqual([]);
    expect(result.scan.errors).toEqual([]);
    expect(result.scan.exit_code).toBe(1);
    expect(result.scan.passed).toBe(false);
    expect(result.scan.hits).toContainEqual({
      rule: 'private-key',
      file: 'assets/material.txt',
      line: 1,
      match: value,
      never_accepted: true,
    });
    expect(result.scan.report.decisions).toContainEqual(
      expect.objectContaining({
        hit: expect.objectContaining({ rule: 'private-key', match: value, never_accepted: true }),
        verdict: 'block',
        reason: 'never_accepted',
      }),
    );
  },
  30_000,
);
