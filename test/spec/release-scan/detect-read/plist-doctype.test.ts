import { expect, it } from 'vitest';
import type { ScanResult } from '../../../../infra/release-scan/detect/index.ts';
import { expectClean, expectMaterial, scan } from './fixtures.ts';

const DOCTYPE =
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';
const DTD_URL = 'http://www.apple.com/DTDs/PropertyList-1.0.dtd';
const FILE = 'Payload/Demo.app/Info.plist';

function plist(body: string, declaration = DOCTYPE): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    declaration,
    '<plist version="1.0"><dict>',
    body,
    '</dict></plist>',
  ].join('\n');
}

function encoded(text: string, encoding: 'utf8' | 'utf16le' | 'utf16be'): Buffer {
  if (encoding === 'utf8') return Buffer.from(text);
  const bytes = Buffer.from(text.replace('encoding="UTF-8"', 'encoding="UTF-16"'), 'utf16le');
  return encoding === 'utf16le'
    ? Buffer.concat([Buffer.from([0xff, 0xfe]), bytes])
    : Buffer.concat([Buffer.from([0xfe, 0xff]), bytes.swap16()]);
}

function expectEntropy(result: ScanResult, match: string, line: number): void {
  expect(result.errors).toEqual([]);
  expect(result.exit_code).toBe(1);
  expect(result.passed).toBe(false);
  expect(result.hits).toContainEqual({
    rule: 'high-entropy',
    file: FILE,
    line,
    match,
    never_accepted: false,
  });
}

it.each(['utf8', 'utf16le', 'utf16be'] as const)(
  '[AC-QA-09f-PLIST#1] %s 标准 DOCTYPE 不误报，声明后真实高熵串及签名盐仍检出且行号不变',
  async (encoding) => {
    const clean = plist('<key>CFBundleName</key><string>Demo</string>');
    expectClean(await scan('ipa', [{ name: FILE, data: encoded(clean, encoding) }]));

    const token = ['01234567', '89abcdef'].join('').repeat(2);
    const salt = ['demo', 'v1'].join('-');
    const body = [
      `<key>Note</key><string>${token}</string>`,
      `<key>shared_salt</key><string>${salt}</string>`,
    ].join('\n');
    const blocked = await scan('ipa', [{ name: FILE, data: encoded(plist(body), encoding) }]);
    expectEntropy(blocked, token, 4);
    expectMaterial(blocked, FILE, salt);
    expect(blocked.hits).toHaveLength(2);
    expect(blocked.hits).toContainEqual({
      rule: 'request-sign-material',
      file: FILE,
      line: 5,
      match: salt,
      never_accepted: true,
    });
  },
);

it('[AC-QA-09f-PLIST#2] 只识别完整标准声明：改动的 DOCTYPE、普通值里的 DTD 地址仍报高熵', async () => {
  const body = '<key>CFBundleName</key><string>Demo</string>';
  expectClean(await scan('ipa', [{ name: FILE, data: plist(body) }]));
  for (const declaration of [
    DOCTYPE.replace('PLIST 1.0', 'PLIST 1.1'),
    DOCTYPE.replace('DOCTYPE plist ', 'DOCTYPE other '),
  ]) {
    const blocked = await scan('ipa', [{ name: FILE, data: plist(body, declaration) }]);
    expectEntropy(blocked, DTD_URL, 2);
  }
  const changedUrl = 'http://www.example.com/DTDs/PropertyList-1.0.dtd';
  expectEntropy(
    await scan('ipa', [{ name: FILE, data: plist(body, DOCTYPE.replace(DTD_URL, changedUrl)) }]),
    changedUrl,
    2,
  );
  expectEntropy(
    await scan('ipa', [{ name: FILE, data: plist(`<key>Note</key><string>${DTD_URL}</string>`) }]),
    DTD_URL,
    4,
  );

  // 同一行声明之后的内容不能随整行删除，含敏感内容的内部子集也不能被宽泛正则吞掉。
  const token = ['01234567', '89abcdef'].join('').repeat(2);
  const sameLine = `${DOCTYPE}<plist version="1.0"><dict><key>Note</key><string>${token}</string></dict></plist>`;
  expectEntropy(await scan('ipa', [{ name: FILE, data: sameLine }]), token, 1);
  const subset = DOCTYPE.replace('>', ` [<!ENTITY demo "${token}">]>`);
  expectEntropy(await scan('ipa', [{ name: FILE, data: plist(body, subset) }]), token, 2);
});
