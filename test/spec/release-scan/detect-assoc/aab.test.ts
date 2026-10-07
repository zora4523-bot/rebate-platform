import { expect, it } from 'vitest';
import { pb, protoElement, protoManifest, pv, resourcesPb } from './android-fixtures.ts';
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

it.each([2, 3, 4] as const)(
  '[AC-QA-09d-AAB#1] protobuf resources.pb 字符串 Item 字段 %s 关联资源名',
  async (stringKind) => {
    const result = await inspect('aab', [
      { name: 'base/manifest/AndroidManifest.xml', data: protoManifest([]) },
      {
        name: 'base/resources.pb',
        data: resourcesPb([{ name: 'shared_salt', values: [SHORT], stringKind }]),
      },
    ]);
    expectPair(result, 'base/resources.pb', 'shared_salt', SHORT);
    expectSecret(result, 'base/resources.pb', SHORT);
  },
  30_000,
);

it.each(['id', 'name'] as const)(
  '[AC-QA-09d-AAB#2] protobuf 资源别名按 %s 解析，扫描所有 ConfigValue',
  async (kind) => {
    const result = await inspect('aab', [
      { name: 'base/manifest/AndroidManifest.xml', data: protoManifest([]) },
      {
        name: 'base/resources.pb',
        data: resourcesPb([
          {
            name: 'install_secret',
            values: [
              kind === 'id'
                ? { ref: 0x7f010001 }
                : { refName: 'com.example.demo:string/build_value' },
            ],
          },
          { name: 'build_value', values: [SHORT, SECOND] },
        ]),
      },
    ]);
    expectPair(result, 'base/resources.pb', 'install_secret', SHORT);
    expectPair(result, 'base/resources.pb', 'install_secret', SECOND);
    expectSecret(result, 'base/resources.pb', SHORT);
    expectSecret(result, 'base/resources.pb', SECOND);
    expect(materialValues(result.scan, 'base/resources.pb')).toEqual([SHORT, SECOND]);
  },
  30_000,
);

it.each(['value', 'resource'] as const)(
  '[AC-QA-09d-AAB#3] proto 清单 meta-data 的 %s 引用与同模块资源表关联',
  async (attribute) => {
    const result = await inspect('aab', [
      {
        name: 'base/manifest/AndroidManifest.xml',
        data: protoManifest([{ name: 'shared_salt', attribute, value: { ref: 0x7f010000 } }]),
      },
      { name: 'base/resources.pb', data: resourcesPb([{ name: 'build_value', values: [SHORT] }]) },
    ]);
    expectPair(result, 'base/manifest/AndroidManifest.xml', 'shared_salt', SHORT);
    expectSecret(result, 'base/manifest/AndroidManifest.xml', SHORT);
  },
  30_000,
);

it.each(['raw', 'compiled'] as const)(
  '[AC-QA-09d-AAB#4] proto 清单内联 %s 值配回 meta-data name',
  async (kind) => {
    const meta = protoElement('meta-data', [
      { name: 'name', raw: 'signKey' },
      { name: 'value', ...(kind === 'raw' ? { raw: SHORT } : { compiled: SHORT }) },
    ]);
    const result = await inspect('aab', [
      {
        name: 'base/manifest/AndroidManifest.xml',
        data: protoElement('manifest', [], [protoElement('application', [], [meta])]),
      },
    ]);
    expectPair(result, 'base/manifest/AndroidManifest.xml', 'signKey', SHORT);
    expectSecret(result, 'base/manifest/AndroidManifest.xml', SHORT);
  },
  30_000,
);

it.each([false, true])(
  '[AC-QA-09d-AAB#5] proto 清单 compiled boolean debuggable=%s 提供字段视图供 QA-09c 使用',
  async (debuggable) => {
    const result = await inspect('aab', [
      {
        name: 'base/manifest/AndroidManifest.xml',
        data: protoManifest([], [{ name: 'debuggable', compiled: { bool: debuggable } }]),
      },
    ]);
    expectPair(
      result,
      'base/manifest/AndroidManifest.xml',
      'debuggable',
      debuggable ? 'true' : 'false',
    );
    // 本任务只提供视图，不把 debug 残留擅自升级成 BR-ID-09 的密钥命中。
    expectClean(result);
  },
  30_000,
);

it.each(['missing-table', 'missing-id', 'self-cycle', 'two-cycle', 'partial-config'] as const)(
  '[AC-QA-09d-AAB#6] 清单签名引用 %s 返回退出码 2',
  async (kind) => {
    const table = resourcesPb([
      {
        name: 'first',
        values:
          kind === 'partial-config'
            ? ['', { ref: 0x7f010099 }]
            : [{ ref: kind === 'self-cycle' ? 0x7f010000 : 0x7f010001 }],
      },
      { name: 'second', values: [{ ref: 0x7f010000 }] },
    ]);
    const result = await inspect('aab', [
      {
        name: 'base/manifest/AndroidManifest.xml',
        data: protoManifest([
          {
            name: 'hmac_secret',
            attribute: 'value',
            value: { ref: kind === 'missing-id' ? 0x7f010099 : 0x7f010000 },
          },
        ]),
      },
      ...(kind === 'missing-table' ? [] : [{ name: 'base/resources.pb', data: table }]),
    ]);
    expectUnreadable(result, 'base/manifest/AndroidManifest.xml');
  },
  30_000,
);

it('[AC-QA-09d-AAB#7] resources.pb 自身的签名字段悬空引用也必须阻断', async () => {
  const result = await inspect('aab', [
    { name: 'base/manifest/AndroidManifest.xml', data: protoManifest([]) },
    {
      name: 'base/resources.pb',
      data: resourcesPb([{ name: 'shared_salt', values: [{ ref: 0x7f010009 }] }]),
    },
  ]);
  expectUnreadable(result, 'base/resources.pb');
}, 30_000);

it('[AC-QA-09d-AAB#8] feature 模块的普通资源也扫描，不能只处理 base', async () => {
  const result = await inspect('aab', [
    { name: 'base/manifest/AndroidManifest.xml', data: protoManifest([]) },
    {
      name: 'feature/manifest/AndroidManifest.xml',
      data: protoManifest([
        { name: 'shared_salt', attribute: 'resource', value: { ref: 0x7f010000 } },
      ]),
    },
    { name: 'feature/resources.pb', data: resourcesPb([{ name: 'build_value', values: [SHORT] }]) },
  ]);
  expectPair(result, 'feature/manifest/AndroidManifest.xml', 'shared_salt', SHORT);
  expectSecret(result, 'feature/manifest/AndroidManifest.xml', SHORT);
}, 30_000);

it.each(['resources.pb', 'manifest/AndroidManifest.xml'])(
  '[AC-QA-09d-AAB#9] %s 的 length-delimited 消息越界不可降级成普通二进制',
  async (file) => {
    const result = await inspect('aab', [
      { name: `base/${file}`, data: Buffer.from([0x0a, 0x7f, 0x00]) },
    ]);
    expectUnreadable(result, `base/${file}`);
  },
  30_000,
);

it.each(['zero-tag', 'truncated-varint', 'bad-wire-type', 'nested-length'] as const)(
  '[AC-QA-09d-AAB#10] resources.pb %s 解析错误必须 fail-closed',
  async (kind) => {
    const malformed = {
      'zero-tag': Buffer.from([0]),
      'truncated-varint': Buffer.from([0x12, 0x80]),
      'bad-wire-type': Buffer.from([0x17]),
      'nested-length': pb(2, Buffer.from([0x1a, 0x7f])),
    }[kind];
    const result = await inspect('aab', [{ name: 'base/resources.pb', data: malformed }]);
    expectUnreadable(result, 'base/resources.pb');
  },
  30_000,
);

it('[AC-QA-09d-AAB#11] 合法 AAB 的未知 protobuf 字段、普通引用与空签名值不得误阻断', async () => {
  const result = await inspect('aab', [
    {
      name: 'base/manifest/AndroidManifest.xml',
      data: protoManifest([
        { name: 'title', attribute: 'value', value: { ref: 0x7f010000 } },
        { name: 'shared_salt', attribute: 'value', value: { ref: 0x7f010001 } },
      ]),
    },
    {
      name: 'base/resources.pb',
      data: Buffer.concat([
        resourcesPb([
          { name: 'label', values: ['Demo'] },
          { name: 'empty', values: [''] },
        ]),
        pv(100, 7),
        pb(101, 'future'),
      ]),
    },
  ]);
  expectPair(result, 'base/manifest/AndroidManifest.xml', 'title', 'Demo');
  expectClean(result);
}, 30_000);

it('[AC-QA-09d-AAB#12] 同时有坏表和可读签名材料：退出码 2 且保留已读命中', async () => {
  const result = await inspect('aab', [
    { name: 'base/resources.pb', data: Buffer.from([0x12, 0x80]) },
    { name: 'feature/resources.pb', data: resourcesPb([{ name: 'shared_salt', values: [SHORT] }]) },
  ]);
  expectUnreadable(result, 'base/resources.pb');
  expect(result.scan.hits).toContainEqual(
    expect.objectContaining({
      rule: 'request-sign-material',
      file: 'feature/resources.pb',
      match: SHORT,
      never_accepted: true,
    }),
  );
}, 30_000);
