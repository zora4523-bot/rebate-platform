import { it } from 'vitest';
import { protoElement, protoManifest } from './android-fixtures.ts';
import { expectClean, expectPair, expectSecret, expectUnreadable, SHORT } from './fixtures.ts';
import { richProtoManifest, richResourcesPb } from './proto-rich-fixtures.ts';
import { inspectRevision } from './revision-inspect.ts';

const providerPaths = {
  name: 'base/res/xml/provider_paths.xml',
  data: protoElement(
    'paths',
    [],
    [
      protoElement('cache-path', [
        { name: 'name', ns: '', raw: 'exports' },
        { name: 'path', ns: '', raw: 'exports/' },
      ]),
    ],
  ),
};

it('[AC-QA-09d-AAB-R2#1] fixed32 浮点、嵌套未知 fixed64、Array 与 FileProvider XML 引用均合法', async () => {
  const result = await inspectRevision('aab', [
    { name: 'base/manifest/AndroidManifest.xml', data: richProtoManifest() },
    { name: 'base/resources.pb', data: richResourcesPb() },
    providerPaths,
  ]);
  expectPair(result, 'base/manifest/AndroidManifest.xml', 'title', 'Demo');
  expectPair(result, 'base/resources.pb', 'label', 'Demo');
  expectClean(result);
}, 30_000);

it('[AC-QA-09d-AAB-R2#2] 跳过合法复合条目和未知字段后，后面的签名资源仍阻断', async () => {
  const result = await inspectRevision('aab', [
    { name: 'base/manifest/AndroidManifest.xml', data: richProtoManifest() },
    { name: 'base/resources.pb', data: richResourcesPb(SHORT) },
    providerPaths,
  ]);
  expectPair(result, 'base/resources.pb', 'shared_salt', SHORT);
  expectSecret(result, 'base/resources.pb', SHORT);
}, 30_000);

it.each([1, 5] as const)(
  '[AC-QA-09d-AAB-R2#3] 嵌套 wire type %s 固定宽度字段缺一个字节必须退出码 2',
  async (wire) => {
    const result = await inspectRevision('aab', [
      { name: 'base/manifest/AndroidManifest.xml', data: richProtoManifest() },
      { name: 'base/resources.pb', data: richResourcesPb('', wire) },
      providerPaths,
    ]);
    expectUnreadable(result, 'base/resources.pb');
  },
  30_000,
);

it('[AC-QA-09d-AAB-R2#4] 普通 meta-data 的外部资源引用不属于签名材料', async () => {
  const result = await inspectRevision('aab', [
    {
      name: 'base/manifest/AndroidManifest.xml',
      data: protoManifest([{ name: 'title', attribute: 'resource', value: { ref: 0x01040000 } }]),
    },
    { name: 'base/resources.pb', data: richResourcesPb() },
    providerPaths,
  ]);
  expectClean(result);
}, 30_000);

it('[AC-QA-09d-AAB-R2#5] 同样的外部资源引用用作签名字段时必须阻断', async () => {
  const result = await inspectRevision('aab', [
    {
      name: 'base/manifest/AndroidManifest.xml',
      data: protoManifest([
        { name: 'shared_salt', attribute: 'resource', value: { ref: 0x01040000 } },
      ]),
    },
    { name: 'base/resources.pb', data: richResourcesPb() },
    providerPaths,
  ]);
  expectUnreadable(result, 'base/manifest/AndroidManifest.xml');
}, 30_000);
