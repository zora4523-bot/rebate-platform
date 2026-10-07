import { expect, it } from 'vitest';
import { buildZip } from '../detect/fixtures.ts';
import { arsc, axml } from './android-fixtures.ts';
import {
  expectClean,
  expectPair,
  expectSecret,
  expectUnreadable,
  inspect,
  materialValues,
  SECOND,
  SHORT,
} from './fixtures.ts';

it.each([
  ['value', false],
  ['resource', false],
  ['value', true],
  ['resource', true],
] as const)(
  '[AC-QA-09d-APK#1] meta-data android:%s 的引用关联 arsc（保留原始字符串=%s）',
  async (attribute, withRaw) => {
    const result = await inspect('apk', [
      {
        name: 'AndroidManifest.xml',
        data: axml([
          {
            name: 'shared_salt',
            attribute,
            value: { ref: 0x7f010000 },
            ...(withRaw ? { raw: '@string/build_value' } : {}),
          },
        ]),
      },
      { name: 'resources.arsc', data: arsc([{ name: 'build_value', value: SHORT }]) },
    ]);
    expectPair(result, 'AndroidManifest.xml', 'shared_salt', SHORT);
    expectSecret(result, 'AndroidManifest.xml', SHORT);
    expect(materialValues(result.scan, 'AndroidManifest.xml')).toEqual([SHORT]);
  },
  30_000,
);

it('[AC-QA-09d-APK#2] 清单引用经过资源别名，扫描全部语言配置，空默认值不掩盖另一配置', async () => {
  const result = await inspect('apk', [
    {
      name: 'AndroidManifest.xml',
      data: axml([{ name: 'install_secret', attribute: 'value', value: { ref: 0x7f010000 } }]),
    },
    {
      name: 'resources.arsc',
      data: arsc(
        [
          { name: 'alias', value: { ref: 0x7f010001 } },
          { name: 'build_value', value: '' },
        ],
        [
          { name: 'alias', value: { ref: 0x7f010001 } },
          { name: 'build_value', value: SECOND },
        ],
      ),
    },
  ]);
  expectPair(result, 'AndroidManifest.xml', 'install_secret', SECOND);
  expectSecret(result, 'AndroidManifest.xml', SECOND);
  expect(materialValues(result.scan, 'AndroidManifest.xml')).toEqual([SECOND]);
}, 30_000);

it.each(['value', 'resource'] as const)(
  '[AC-QA-09d-APK#3] %s 签名引用指向不存在的 ID，必须 fail-closed',
  async (attribute) => {
    const result = await inspect('apk', [
      {
        name: 'AndroidManifest.xml',
        data: axml([{ name: 'shared_salt', attribute, value: { ref: 0x7f010009 } }]),
      },
      { name: 'resources.arsc', data: arsc([{ name: 'build_value', value: 'Demo' }]) },
    ]);
    expectUnreadable(result, 'AndroidManifest.xml');
  },
  30_000,
);

it.each(['missing', 'self-cycle', 'two-cycle', 'partial-config', 'framework'] as const)(
  '[AC-QA-09d-APK#4] 签名引用 %s 不得作为无取值放行',
  async (kind) => {
    const resource = kind === 'framework' ? 0x01040000 : 0x7f010000;
    const table = arsc([
      { name: 'first', value: { ref: kind === 'self-cycle' ? 0x7f010000 : 0x7f010001 } },
      { name: 'second', value: { ref: 0x7f010000 } },
    ]);
    const result = await inspect('apk', [
      {
        name: 'AndroidManifest.xml',
        data: axml([{ name: 'signKey', attribute: 'value', value: { ref: resource } }]),
      },
      ...(kind === 'missing'
        ? []
        : [
            {
              name: 'resources.arsc',
              data:
                kind === 'partial-config'
                  ? arsc(
                      [{ name: 'first', value: '' }],
                      [{ name: 'first', value: { ref: 0x7f010099 } }],
                    )
                  : table,
            },
          ]),
    ]);
    expectUnreadable(result, 'AndroidManifest.xml');
  },
  30_000,
);

it('[AC-QA-09d-APK#5] 不得用兄弟 APK 的同 ID 空资源满足当前 APK 的签名引用', async () => {
  const result = await inspect('apk', [
    {
      name: 'AndroidManifest.xml',
      data: axml([{ name: 'shared_salt', attribute: 'resource', value: { ref: 0x7f010000 } }]),
    },
    {
      name: 'assets/other.apk',
      data: buildZip([
        { name: 'AndroidManifest.xml', data: axml([]) },
        { name: 'resources.arsc', data: arsc([{ name: 'build_value', value: '' }]) },
      ]),
    },
  ]);
  expectUnreadable(result, 'AndroidManifest.xml');
}, 30_000);

it.each([
  'axml-truncated',
  'axml-type',
  'axml-size',
  'axml-pool-offset',
  'arsc-truncated',
  'arsc-size',
] as const)(
  '[AC-QA-09d-APK#6] 损坏的 %s 必须返回读取错误',
  async (kind) => {
    let manifest = axml([]);
    let table = arsc([{ name: 'label', value: 'Demo' }]);
    if (kind === 'axml-truncated') manifest = manifest.subarray(0, manifest.length - 1);
    if (kind === 'axml-type') manifest.writeUInt16LE(0, 0);
    if (kind === 'axml-size') manifest.writeUInt32LE(manifest.length + 4, 4);
    if (kind === 'axml-pool-offset') manifest.writeUInt32LE(0xfffffff0, 36);
    if (kind === 'arsc-truncated') table = table.subarray(0, table.length - 1);
    if (kind === 'arsc-size') table.writeUInt32LE(0xfffffff0, 4);
    const result = await inspect('apk', [
      { name: 'AndroidManifest.xml', data: manifest },
      { name: 'resources.arsc', data: table },
    ]);
    expectUnreadable(result, kind.startsWith('axml') ? 'AndroidManifest.xml' : 'resources.arsc');
  },
  30_000,
);

it('[AC-QA-09d-APK#7] 合法 APK 的普通 metadata 引用和已解析的空签名资源必须放行', async () => {
  const result = await inspect('apk', [
    {
      name: 'AndroidManifest.xml',
      data: axml([
        { name: 'title', attribute: 'resource', value: { ref: 0x7f010000 } },
        { name: 'shared_salt', attribute: 'value', value: { ref: 0x7f010001 } },
      ]),
    },
    {
      name: 'resources.arsc',
      data: arsc([
        { name: 'label', value: 'Demo' },
        { name: 'empty', value: '' },
      ]),
    },
  ]);
  expectPair(result, 'AndroidManifest.xml', 'title', 'Demo');
  expectClean(result);
}, 30_000);

it('[AC-QA-09d-APK#8] 二进制清单内联短签名材料仍阻断', async () => {
  const result = await inspect('apk', [
    {
      name: 'AndroidManifest.xml',
      data: axml([{ name: 'shared_salt', attribute: 'value', value: SHORT }]),
    },
  ]);
  expectPair(result, 'AndroidManifest.xml', 'shared_salt', SHORT);
  expectSecret(result, 'AndroidManifest.xml', SHORT);
}, 30_000);
