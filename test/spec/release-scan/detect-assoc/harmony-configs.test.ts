import { expect, it } from 'vitest';
import { expectClean, expectPair, expectSecret, expectUnreadable, SHORT } from './fixtures.ts';
import { moduleJson } from './harmony-fixtures.ts';
import { configuredResourcesIndex, localizedConfigs } from './harmony-config-fixtures.ts';
import { inspectRevision } from './revision-inspect.ts';

const profile = { name: 'resources/base/profile/routes.json', data: '{"src":["pages/Index"]}' };
const icon = {
  name: 'resources/base/media/icon.svg',
  data: '<svg xmlns="http://www.w3.org/2000/svg"/>',
};

it('[AC-QA-09d-HAP-R2#1] 三套配置与 MEDIA/COLOR/PROF、普通 $profile 引用是合法 HAP', async () => {
  const result = await inspectRevision('hap', [
    {
      name: 'module.json',
      data: moduleJson([
        { name: 'title', resource: '$string:build_value' },
        { name: 'router', resource: '$profile:routes' },
        { name: 'shared_salt', value: '' },
      ]),
    },
    {
      name: 'resources.index',
      data: configuredResourcesIndex(localizedConfigs(['Demo', 'Welcome', '欢迎'])),
    },
    profile,
    icon,
  ]);
  for (const value of ['Demo', 'Welcome', '欢迎']) {
    expectPair(result, 'module.json', 'title', value);
  }
  expectClean(result);
}, 30_000);

it.each([1, 2] as const)(
  '[AC-QA-09d-HAP-R2#2] 仅第 %s 个非 base 配置含签名材料，引用必须检查全部候选',
  async (configIndex) => {
    const values: [string, string, string] = ['', '', ''];
    values[configIndex] = SHORT;
    const result = await inspectRevision('hap', [
      {
        name: 'module.json',
        data: moduleJson([{ name: 'shared_salt', resource: '$string:build_value' }]),
      },
      { name: 'resources.index', data: configuredResourcesIndex(localizedConfigs(values)) },
      profile,
      icon,
    ]);
    expectPair(result, 'module.json', 'shared_salt', SHORT);
    expectSecret(result, 'module.json', SHORT);
    expect(result.scan.hits.some((hit) => hit.match === '$string:build_value')).toBe(false);
  },
  30_000,
);

it('[AC-QA-09d-HAP-R2#3] 非 base 的签名资源名独立扫描，不依赖 metadata 引用', async () => {
  const configs = localizedConfigs(['Demo', 'Welcome', '欢迎']);
  configs[2] = {
    ...configs[2]!,
    records: [
      ...configs[2]!.records,
      { id: 0x01000004, type: 9, name: 'shared_salt', value: SHORT },
    ],
  };
  const result = await inspectRevision('hap', [
    { name: 'module.json', data: moduleJson([]) },
    { name: 'resources.index', data: configuredResourcesIndex(configs) },
    profile,
    icon,
  ]);
  expectPair(result, 'resources.index', 'shared_salt', SHORT);
  expectSecret(result, 'resources.index', SHORT);
}, 30_000);

it('[AC-QA-09d-HAP-R2#4] 普通 $profile 外部引用无法解析不冒充签名材料', async () => {
  const result = await inspectRevision('hap', [
    {
      name: 'module.json',
      data: moduleJson([{ name: 'router', resource: '$profile:external_routes' }]),
    },
    {
      name: 'resources.index',
      data: configuredResourcesIndex(localizedConfigs(['Demo', 'Welcome', '欢迎'])),
    },
    profile,
    icon,
  ]);
  expectClean(result);
}, 30_000);

it.each(['missing-reference', 'idss-offset'] as const)(
  '[AC-QA-09d-HAP-R2#5] 第三套配置的 %s 出错不能被 base 的空值掩盖',
  async (kind) => {
    const table = configuredResourcesIndex(
      localizedConfigs(['', '', kind === 'missing-reference' ? '$string:16777315' : '']),
    );
    // base KEYS 12 字节，en_US KEYS 28 字节；第三个 KEYS.offset 位于 136+12+28+4。
    if (kind === 'idss-offset') table.writeUInt32LE(table.length + 8, 180);
    const result = await inspectRevision('hap', [
      {
        name: 'module.json',
        data: moduleJson([{ name: 'shared_salt', resource: '$string:build_value' }]),
      },
      { name: 'resources.index', data: table },
      profile,
      icon,
    ]);
    expectUnreadable(result, kind === 'idss-offset' ? 'resources.index' : 'module.json');
  },
  30_000,
);
